# Sentinelle — how the detection works, and how it's defeated

This is the writeup for the half of the project that most people skip: the detector.

The argument for building it is simple. **You cannot reliably evade a detector you
could not have written yourself.** Evasion built by guessing produces code that works
until it silently doesn't, and you find out when the account is banned rather than
when the check changed.

Sentinelle is not a reimplementation of DataDome or any other vendor. It has the same
*shape* — a cheap transport gate, then a JS probe, then behavioural scoring over the
session — with weights chosen for legibility rather than reverse-engineered from
anyone's product.

---

## Three layers, in cost order

The ordering is economic, not architectural. Each layer is more expensive to run than
the last, so each one only sees traffic the previous one didn't resolve.

| Layer | Runs | Costs | Catches |
|---|---|---|---|
| **Transport** | every request, before any JS | nothing | `curl`, `requests`, unconfigured HTTP clients |
| **Fingerprint** | once per session, in-page | one script | headless browsers, and *badly-patched* ones |
| **Behaviour** | continuously, over the session | telemetry + stats | everything else |

The third layer is the one that matters. Fingerprints are a static puzzle: solve them
once and the answer keeps working until the vendor ships a new probe. Behaviour is a
*continuous* signal you have to keep producing convincingly for as long as the session
lasts, and there is no one-time patch for it.

---

## Layer 1 — transport

Decided at connection time, before a single byte of JavaScript runs.

### Header order

Chrome emits request headers in a stable, build-specific order. HTTP client libraries
emit them in insertion or alphabetical order. Most spoofing code never touches order
at all — because **every tool a developer uses to inspect headers shows them as a
map**, and a map has already thrown the ordering away.

Sentinelle scores conformance with a longest-increasing-subsequence over the
canonical ranks of the headers it recognises:

```ts
const inOrder = lisLength(ranked);        // headers that are in canonical order
const conformance = inOrder / ranked.length;
if (conformance < 0.8) raise('http.header_order', ...);
```

Only scored when at least six known headers are present — scoring a three-header
request would be noise, and noise in a bot detector costs customers.

**Countermeasure:** `Fetch.continueRequest` accepts an **ordered array** of header
entries. This is the single most concrete reason the worker speaks raw CDP: every
higher-level automation API exposes headers as a dictionary. See
[`cdp/headerOrder.ts`](../worker/src/cdp/headerOrder.ts) and
[ADR 0002](adr/0002-raw-cdp-over-playwright.md).

### Client Hints coherence

`Sec-CH-UA` and the `User-Agent` string are derived from the same Chrome build. A
spoofer that rewrites one and forgets the other produces a combination **no real
build can emit** — which is stronger evidence than either header alone.

**Countermeasure:** `Network.setUserAgentOverride` carries `userAgentMetadata`
alongside the UA string. Both come from the same persona object in
[`proxy/pool.ts`](../worker/src/proxy/pool.ts), so they cannot drift.

### `probe.silent` — the ceiling on header spoofing

The heaviest signal in the catalog (weight 40), and the only transport check that
cannot be satisfied by formatting a request more carefully.

Every page Vitrine serves carries `<script src="/probe.js">`. Anything with an HTML
parser fetches it. Anything that treats the response as a string does not.

```ts
if (servedHtml && !fetchedProbe) raise('probe.silent', ...);
```

That is the whole check, and getting to it took two wrong versions — both of which
only surfaced by running the demo, and both of which are the same mistake:

- **"No telemetry yet."** Flags a fast browser that navigates again before its first
  telemetry POST lands. Racy, and the obvious fix (a grace period) is unwinnable:
  long enough to avoid the race is long enough for a 0.1-second raw-HTTP run to slip
  under it.
- **"No Sec-Fetch metadata."** Looked timing-independent, and was worse — Chrome does
  not send Sec-Fetch on a plain-HTTP origin at all, so every real browser on this
  deployment looked programmatic and scored 40 points for it.

A subresource fetch is neither racy nor origin-dependent. And the signal is
deliberately about *fetching* rather than *executing*: fetching already proves an
HTML parser ran, and it avoids penalising a browser whose telemetry POST failed in
flight.

This is also the one signal in the catalog with no counter-measure in
`worker/src/stealth`. The answer to it is "run an actual browser", which is precisely
why the `raw-http` profile exists and why it is the one that never gets through.

### Rate and egress

A Redis token bucket per egress IP, and an ASN class check. Residential proxies exist
to defeat exactly these two signals, which is why they are priced per gigabyte.

---

## Layer 2 — browser fingerprint

An in-page probe collects ~20 signals and posts them. Everything is evaluated
server-side: the client is hostile by construction, so the probe is a sensor and the
server is the judge.

The classic tells are here — `navigator.webdriver`, empty `plugins`, SwiftShader
WebGL, the `Notification.permission` / `permissions.query()` contradiction, zeroed
`outerHeight`. Two are more interesting.

### `fp.function_tostring_tampered` — the bad-stealth detector

This one does not detect automation. It detects **evasion that was attempted and
botched**, which is a smaller and far more distinctive population.

The obvious way to hide the automation flag is:

```js
Object.defineProperty(navigator, 'webdriver', { get: () => false })
```

This is worse than doing nothing. In a real Chrome that getter is native code; after
the patch it is an ordinary JavaScript function, and one line says so:

```js
Function.prototype.toString.call(
  Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver').get
)
// real Chrome:  "function get webdriver() { [native code] }"
// naive patch:  "() => false"
```

A browser reporting `webdriver === false` from a *tampered* getter is not a normal
browser. It is an automated one that is actively lying.

**Countermeasure** ([`stealth/nativeShim.ts`](../worker/src/stealth/nativeShim.ts)):
replace `Function.prototype.toString` with a Proxy that returns a native-looking
string for registered functions and defers to the real implementation otherwise. The
subtle part is the last line of defence — **the proxy must lie about itself**:

```js
fakeSources.set(toStringProxy, 'function toString() { [native code] }');
```

Otherwise the tool built to hide the tampering *is* the tampering.

What it still doesn't survive is documented in that file rather than glossed over:
Proxies are observable in ways that are hard to close in general, stack introspection
can reach frames the proxy doesn't mediate, and a fresh same-origin iframe gives the
detector a clean realm. The honest conclusion is that **this arms race is won by not
needing to patch** — launch flags and CDP overrides fix things at the source and leave
nothing behind, which is why the worker prefers them and treats patches as the
fallback.

### `fp.canvas_known_headless` — cohort, not hash

Matching a hardcoded known-bad canvas hash only catches yesterday's containers. The
version that actually works watches for **one hash worn by many identities**: a
thousand identical containers cannot render a thousand different canvases.

```ts
const cohort = await store.recordCanvasCohort(fp.canvasHash, sessionId);
if (cohort >= 5) raise('fp.canvas_known_headless', `shared by ${cohort} sessions`);
```

**Countermeasure:** per-identity noise that is **deterministic**. The common mistake
is randomising on every read — a detector that reads the canvas twice and gets two
different values has caught something far more specific than a shared hash, because
no real browser's canvas changes between consecutive reads.

---

## Layer 3 — behaviour

Descriptive statistics over an event stream. No ML, deliberately: a handful of
well-chosen moments is interpretable, debuggable and adversarially honest, whereas a
model lets the demo hide its reasoning behind a number nobody can argue with.

### Pointer paths

| Statistic | Threshold | What it catches |
|---|---|---|
| R² of a linear fit | `> 0.99` | interpolating A→B in a straight line |
| speed coefficient of variation | `< 0.2` | constant-velocity walk on a timer |
| max single-sample displacement | `> 300px` | assigning coordinates instead of moving |
| clicks with zero preceding mousemove | any | `element.click()` |

The last one is the loudest signal in the whole catalog and it is the **default
behaviour of every automation library**.

**Countermeasure** ([`behavior/mouse.ts`](../worker/src/behavior/mouse.ts)) — three
separate models, because each statistic needs its own:

1. **Duration — Fitts's law**, Shannon form: `MT = a + b·log₂(D/W + 1)`. Movement
   time grows with distance and shrinks with target size. A fixed duration, or one
   proportional to distance alone, has the wrong *shape*, and shape is what a detector
   with a few hundred samples measures.
2. **Trajectory — cubic Bézier**, control points offset perpendicular to the straight
   line. The bow magnitude is load-bearing: an arc whose sagitta is under ~5% of the
   movement distance still fits a straight line above R² 0.99.
   [The test asserts this](../worker/src/behavior/mouse.test.ts) against the
   detector's real threshold, so tightening the bow fails the build rather than
   silently producing detectable paths.
3. **Velocity — minimum jerk**: `s(t) = 10t³ − 15t⁴ + 6t⁵`. Given the path, you still
   have to choose *when* along it to be. This produces the bell-shaped velocity curve
   from the motor-control literature — accelerate, peak near the midpoint, decelerate
   into the target. Walking the Bézier at constant `t` instead is exactly what trips
   `bhv.constant_velocity`.

Plus overshoot-and-correct (fast aimed movements frequently overshoot; the corrective
submovement puts a second bump in the velocity profile) and sub-pixel tremor.

### Typing

| Statistic | Threshold |
|---|---|
| inter-keystroke interval CV | `< 0.15` |
| mean interval | `< 25ms` |

The instructive failure here is the *plausible* one. `sleep(random(80, 120))` between
keys passes the mean check and **fails the variation check** — uniform noise over that
range has a CV around 0.12.

Human keying is:

- **Right-skewed** — a floor set by biomechanics, a long tail set by attention.
  Log-normal, not uniform.
- **Digraph-dependent** — alternating hands is fast (`the`), same-finger repeats are
  slow (`ll`). Modelled as a hand-alternation bonus and a same-key penalty.
- **Structured** — a pause before a capital, after punctuation, at word boundaries.
- **Error-prone** — ~1.8% of keystrokes are wrong, noticed a beat later, repaired with
  backspace. The repair is unmistakably human: a burst, a pause, a correction.

The typo model uses **AZERTY** adjacency, because every persona in the identity pool
is French. A `fr-FR` browser whose typos are QWERTY-adjacent is a small contradiction,
and the argument of this whole project is that small contradictions are what get
caught.

### Why the events have to be real

`bhv.no_ambient_events` is the lightest signal in the catalog (weight 6), and the
technique it forces is the interesting part. The wrong answer:

```js
window.dispatchEvent(new Event('resize'))   // isTrusted === false
```

Any handler can read `isTrusted`, so the fake is not merely useless — it is a *new*
signal saying the page is being manipulated from inside. The same trap catches
synthetic clicks, key events and focus.

The right answer is to make the browser produce the event for real, from outside the
page, by changing the thing the event reports on:
`Emulation.setDeviceMetricsOverride` genuinely resizes the viewport, so the resize
event is genuinely trusted.

---

## Combining evidence: noisy-OR, not a sum

```
score = 100 · (1 − Π(1 − wᵢ/100))
```

Each signal is read as "probability this session is automated, given only this
evidence". Noisy-OR asks the complementary question — what is the chance *every*
signal is independently a false alarm — and takes one minus that.

Three reasons over a weighted sum:

- **It saturates.** Twelve weak signals cannot add to 400 and manufacture certainty
  out of noise. A sum has to be clamped, which silently discards the difference
  between "suspicious" and "wildly suspicious".
- **It's sub-additive.** Evidence still accumulates, but the tenth signal moves the
  score far less than the first — which matches reality, since empty plugins AND empty
  languages AND no media devices are all *"this is headless"* and shouldn't be
  triple-counted at full strength.
- **Weights stay interpretable.** `fp.webdriver = 35` means "on its own, 35% of the
  way to certainty", and that reading survives adding new signals later. With a sum,
  every new signal silently reweights every old one.

The independence assumption is wrong in exactly the way described above, so this
**under-penalises correlated evidence**. That is the safe direction to be wrong in for
a bot detector, where a false positive is a lost customer and a false negative is one
more scrape.

### Three bands, not two

`allow < 30 ≤ challenge < 60 ≤ block`

A detector with only allow/block has to pick one threshold and eat either false
positives or false negatives. The challenge band lets ambiguous sessions prove
themselves cheaply — the DataDome interstitial, the Cloudflare turnstile — and gives
the worker something interesting to handle: a challenge is recoverable, a block means
the identity is burned.

Vitrine's challenge asks for a deliberate pointer gesture, which is honest about what
it tests: not "are you human" but "will you pay the behavioural cost of looking like
one". A scripted actuator has no pointer and simply cannot pass. That's the correct
outcome, not a bug.

---

## What this deliberately does not model

- **TLS fingerprinting (JA3/JA4) and the HTTP/2 SETTINGS frame.** The most valuable
  transport signals in production, and Node's `http` module surfaces neither.
  Sentinelle approximates transport identity with header order and Client Hints
  instead. A real detector fingerprints the handshake, and that is genuinely harder to
  defeat than anything here — it requires a custom TLS stack, not a browser flag.
- **IP intelligence.** A static prefix table instead of an ASN feed with
  proxy/VPN/hosting reputation refreshed continuously.
- **CAPTCHA.** The challenge is an interaction test, not a puzzle.
- **Obfuscation.** The probe is served unminified. Real vendors obfuscate heavily, but
  that is friction, not defence — the security property is that producing *convincing*
  values for all of it simultaneously is expensive, not that the checks are secret.
- **ML scoring.** See above: interpretability was worth more here than accuracy.

---

## The uncomfortable conclusion

The most effective anti-anti-bot measure in this codebase is not the
`Function.prototype.toString` proxy or the Bézier paths.

**It is being slower.**

Every evasion technique here is cheaper for a defender to detect than patience is for
an attacker to fake. Rate limits, dwell times, reading pauses, the cost of a
residential IP — these are economic defences, and economics is the only part of this
that doesn't have a clever workaround.

That is also why the honest framing for anyone building on the other side is
**detection, not prevention**: you will not stop a determined, well-funded scraper.
You will make it expensive, slow, and visible — and then you decide what to do about
the traffic you can see.
