# revendo

**A marketplace automation control plane — and the anti-bot system it has to beat.**

Two halves that were built against each other:

- **Sentinelle** — a bot-detection engine. 31 signals across transport, browser
  fingerprint and behaviour, combined with a noisy-OR, guarding a fake French resale
  marketplace.
- **The worker** — a browser automation stack that drives Chrome over raw CDP, with a
  fingerprint-patching layer and a human-behaviour engine built to defeat it.

Plus a **Kotlin/Ktor control plane** that owns the listing lifecycle, the retry
policy and the rate budget, and a **RabbitMQ/Redis** spine between them.

Everything runs offline. No API keys, no external services, no live target.

```bash
make demo
```

---

## What the demo shows

Three clients run **the same publish flow** against **the same detector**. The only
thing that changes is how they touch the page.

```
  SCOREBOARD  (worst verdict per session)

  score  verdict     signals  action    result
   68    block           6    publish   ✗ raw HTTP, no browser
   79    block           9    publish   ✗ HeadlessChrome · element.click()
    0    allow           0    publish   ✓ Chrome/Win64 · Fitts-timed pointer
```

Those are measured numbers from an actual run, not illustrations.

- **`raw-http`** (68, blocked, 0.1s) — plain `fetch()`. Dies on transport signals
  before any JavaScript runs. The heaviest hit is `probe.silent`: it was served a
  page carrying the detector's script, never executed it, and then called the API
  directly. You can fake every header; you cannot fake having run JavaScript.
- **`naive`** (79, blocked, 1.3s) — real Chrome over CDP, but `element.click()` and
  `el.value = "…"`. Challenged on transport at 47, and the probe running on the
  interstitial then pushed it to 79 on fingerprint and behaviour.
- **`stealth`** (0, published, 73s) — *same flow, same selectors, same form data.*
  Coherent identity, laundered native functions, Fitts-timed pointer paths,
  log-normal keystrokes. A clean sheet against all 32 signals.

The 73 seconds are the finding, not an inconvenience. Every other countermeasure here
is cheaper for a defender to detect than patience is for an attacker to fake —
`BEHAVIOR_PACE` is the dial, and turning it *down* is what gets you caught.

Watch it live at **http://localhost:8080/__sentinelle** — every signal, its weight,
and the evidence that raised it, streaming in as it happens.

The naive and stealth runs execute **identical code paths**. The scraping flow is
written once against an `Actuator` interface; swapping the implementation is the only
difference. There is nowhere to hide a `if (stealth)` special case, so the comparison
is genuinely like-for-like.

---

## Why build the detector too

Because you cannot reliably evade a detector you could not have written yourself.

Writing both halves forces the interesting questions into the open:

- **What is actually cheap to detect?** Header order costs a defender nothing and is
  invisible in every tool a developer normally uses. That asymmetry is the whole game.
- **Where does evasion make things worse?** `fp.function_tostring_tampered` doesn't
  detect automation — it detects *sloppy* automation. Redefining
  `navigator.webdriver` with a plain getter leaves a JS function where the engine
  guarantees a native one, and a browser that is actively lying is a smaller, more
  interesting population than one that simply is what it is.
- **What can't be patched?** Behaviour. A fingerprint is a static puzzle you solve
  once; behaviour is a continuous signal you have to keep producing convincingly for
  the whole session. The most effective countermeasure in this codebase is **being
  slower**.

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
   POST /listings   │  CONTROL PLANE  (Kotlin · Ktor)          │
  ─────────────────▶│                                          │
                    │  sealed-class state machine → Effect[]   │
                    │  retry ladder · rate budget · idempotency│
                    └───────┬──────────────────────────▲───────┘
                            │ publish job              │ result
                    ┌───────▼──────────────────────────┴───────┐
                    │  RabbitMQ   jobs · retry tiers · DLQ     │
                    └───────┬──────────────────────────▲───────┘
                            │                          │
                    ┌───────▼──────────────────────────┴───────┐
                    │  WORKER  (TypeScript · raw CDP)          │
                    │                                          │
                    │  identity ─ stealth bootstrap ─ actuator │
                    └────────────────────┬─────────────────────┘
                                         │ Chrome, over the wire
                    ┌────────────────────▼─────────────────────┐
                    │  VITRINE  (marketplace)                  │
                    │    guarded by SENTINELLE                 │
                    │    transport → fingerprint → behaviour   │
                    └──────────────────────────────────────────┘

                    Redis: rate buckets · idempotency · identities · sessions
```

**Why the split.** The control plane and the data plane have opposite failure modes
and opposite scaling curves. The orchestrator is IO-bound, holds all the state, and
must never die. The browser workers are memory-hogs that die constantly and must be
disposable. Putting them in one process means the thing that must not die shares a
heap with the thing that reliably OOMs.

**Why polyglot.** The evasion payloads are JavaScript no matter what the host
language is — patching `navigator.webdriver` ships as JS injected via
`Page.addScriptToEvaluateOnNewDocument`. Writing the worker in Kotlin would not have
made that Kotlin; it would have added a translation layer to no benefit. The control
plane is where a type system and a sealed hierarchy actually earn their keep.

---

## The two halves, joined

Every signal Sentinelle raises has a named counter-measure, and
[a test](worker/src/stealth/coverage.test.ts) fails the build if one goes missing.

| Layer | Signal | Counter-measure |
|---|---|---|
| transport | `http.header_order` | `Fetch.continueRequest` with an **ordered array** — [why raw CDP](docs/adr/0002-raw-cdp-over-playwright.md) |
| transport | `http.ch_ua_mismatch` | `userAgentMetadata` derived from the same persona as the UA string |
| transport | `http.datacenter_asn` | residential egress, one IP per identity |
| fingerprint | `fp.webdriver` | `--disable-blink-features=AutomationControlled` first; JS patch only as fallback |
| fingerprint | `fp.function_tostring_tampered` | [`nativeShim.ts`](worker/src/stealth/nativeShim.ts) — a `toString` Proxy that lies about itself |
| fingerprint | `fp.canvas_known_headless` | per-identity **deterministic** noise (randomising per call is a louder tell) |
| fingerprint | `fp.timezone_mismatch` | `Emulation.setTimezoneOverride` — a real clock, not a lie about one |
| behaviour | `bhv.linear_path` | cubic Bézier with distance-scaled bow, [asserted against the detector's R² threshold](worker/src/behavior/mouse.test.ts) |
| behaviour | `bhv.constant_velocity` | minimum-jerk profile `10t³−15t⁴+6t⁵` |
| behaviour | `bhv.typing_uniform` | log-normal intervals, digraph-aware, AZERTY typo model |

Full catalog with weights and rationale: [`docs/ANTI-BOT.md`](docs/ANTI-BOT.md), or
`curl localhost:8080/__sentinelle/catalog`.

---

## What's real and what's simulated

Stated plainly, because a demo that overstates itself is worse than one that doesn't.

**Real:**
- Chrome driven over the actual DevTools Protocol — `Input.dispatchMouseEvent`,
  `Fetch.continueRequest`, `Emulation.*`, `Target.createBrowserContext`. No Playwright.
- The fingerprint patches, including the `Function.prototype.toString` laundering.
- The behaviour model: Fitts's law, minimum-jerk velocity, log-normal keystroke
  timing. Statistically asserted against the detector's real thresholds.
- The detection engine: header-order conformance by longest-increasing-subsequence,
  noisy-OR combination, canvas-cohort analysis, behavioural moment statistics.
- The distributed machinery: RabbitMQ retry tiers with dead-letter routing, Redis Lua
  token buckets, compare-and-set updates, idempotency keys.

**Simulated, and why:**
- **Residential proxies** — egress is `X-Forwarded-For` rather than real upstream
  proxies, so the demo runs offline with no credentials. The seam is real:
  `Identity.proxyUrl` threads through to `Target.createBrowserContext({proxyServer})`.
- **TLS fingerprinting (JA3/JA4)** — Node's `http` module doesn't surface the
  ClientHello, so Sentinelle approximates transport identity with header order and
  Client Hints. A production detector fingerprints the TLS handshake, and that is
  genuinely harder to defeat than anything modelled here.
- **IP reputation** — a static prefix table instead of an ASN intelligence feed.
- **DataDome itself** — Sentinelle is not a reimplementation of any vendor. It has
  the same *shape* (cheap transport gate → JS probe → behavioural scoring) with
  weights chosen for legibility, not reverse-engineered.

---

## Engineering decisions

Each of these has an ADR with the alternatives and the trade-off:

| Decision | Why |
|---|---|
| [Split control plane from data plane](docs/adr/0001-split-control-and-data-plane.md) | Opposite failure modes, opposite scaling curves |
| [Raw CDP over Playwright](docs/adr/0002-raw-cdp-over-playwright.md) | Header order is an ordered array; a map has thrown it away |
| [Pure state machine returning effects](docs/adr/0003-functional-core-imperative-shell.md) | The interesting logic tests in milliseconds with no infrastructure |
| [Redis over Postgres, and what it costs](docs/adr/0004-redis-and-the-outbox-we-do-not-have.md) | One datastore for the demo; the transactional gap named explicitly |
| [Tiered retry queues, not per-message TTL](docs/adr/0005-retry-tiers-over-per-message-ttl.md) | RabbitMQ dead-letters from the head only — per-message TTL head-of-line blocks |

Details worth a look if you only read code:

- [`domain/StateMachine.kt`](control-plane/src/main/kotlin/com/revendo/domain/StateMachine.kt)
  — a pure `(state, event) → (state, Effect[])` with typed illegal transitions and
  full-jitter backoff. A blocked publish **burns the identity** before retrying.
- [`infra/TokenBucket.kt`](control-plane/src/main/kotlin/com/revendo/infra/TokenBucket.kt)
  — Redis Lua so refill-check-consume is atomic; the naive version is a
  read-modify-write race that only fails under the concurrency it exists to handle.
- [`stealth/nativeShim.ts`](worker/src/stealth/nativeShim.ts) — includes an honest
  list of what it still doesn't survive.
- [`behavior/actuator.ts`](worker/src/behavior/actuator.ts) — the seam that makes the
  naive/stealth comparison like-for-like.
- [`negotiation/NegotiationAgent.kt`](control-plane/src/main/kotlin/com/revendo/negotiation/NegotiationAgent.kt)
  — the model drafts the message; the **price floor is enforced in a `when` branch**,
  because a buyer's text reaches the prompt and a floor you can argue with is not a
  floor.

---

## Pipeline

[`.github/workflows/`](.github/workflows/) — four workflows, least-privilege by
default, findings to the Security tab as SARIF and the build failing only on
HIGH/CRITICAL. A gate that cries wolf gets switched off in week three.

| | |
|---|---|
| [`ci.yml`](.github/workflows/ci.yml) | typecheck + 56 tests across three languages, image builds, **and an e2e gate that asserts the claim**: naive must be blocked, stealth must publish. Everything else can be green while that quietly stops being true. |
| [`security.yml`](.github/workflows/security.yml) | Gitleaks (full history), Semgrep + CodeQL for TS *and* Kotlin, Trivy filesystem and per-image scans, Hadolint, CycloneDX SBOMs retained 90 days |
| [`dast.yml`](.github/workflows/dast.yml) | OWASP ZAP against the live stack |
| [`ai-review.yml`](.github/workflows/ai-review.yml) | Claude reviewing PRs against *this codebase's* failure modes — stealth patches that add a detectable artefact, detector signals that would fire on real users, state-machine invariants |

The DAST job has a problem worth reading: **the scanner is a bot, and this repo built
an anti-bot system.** ZAP trips `probe.silent`, `http.datacenter_asn` and the rate
limiter within seconds, gets a 403 for the rest of the run, and reports a clean scan
because it never reached the application. That is the classic false negative in
DAST-behind-a-WAF. The fix is the one every real engagement uses — scan the origin
with enforcement off — so the job sets `MONITOR_ONLY`, *asserts the header came back
to prove it took effect*, and then prints what Sentinelle made of the scanner
afterwards. Two findings for one job.

`.zap/rules.tsv` tunes the baseline, and every `IGNORE` says why it is ignored.

---

## Commands

```bash
make demo          # build, start, run all three profiles, print the scoreboard
make up            # just start the stack
make console       # open the Sentinelle console
make test          # every suite, in containers — no Node or JDK needed on the host
make down          # stop
make clean         # stop and remove volumes + images
```

Individual runs:

```bash
make demo-raw      # no browser
make demo-naive    # headless Chrome, no countermeasures
make demo-stealth  # the full stack
```

Endpoints:

| | |
|---|---|
| marketplace | http://localhost:8080 |
| detection console | http://localhost:8080/__sentinelle |
| signal catalog | http://localhost:8080/__sentinelle/catalog |
| control plane | http://localhost:8081/listings |
| metrics | http://localhost:8081/metrics |
| rabbitmq | http://localhost:15672 · guest/guest |

Try `MONITOR_ONLY=true make up` to watch Sentinelle score without enforcing — the
mode every real deployment starts in, for weeks, before anyone dares turn on blocking.

---

## Layout

```
control-plane/   Kotlin · Ktor · lifecycle, retries, rate budget, negotiation
  domain/          pure state machine + retry policy
  infra/           Lettuce Redis, Lua token bucket, idempotency, CAS repository
  queue/           RabbitMQ topology, publisher confirms, result consumer

worker/          TypeScript · raw CDP
  cdp/             Chrome lifecycle, session/context, header ordering
  stealth/         native-function shim + fingerprint patches
  behavior/        mouse, typing, scroll, dwell, ambient — and the actuator seam
  proxy/           coherent identities, sticky per account
  adapters/        the site-specific half (and a no-browser baseline)

target-site/     TypeScript · the marketplace and its detector
  sentinelle/      catalog, noisy-OR scoring, transport/fingerprint/behaviour
  public/probe.js  the in-page sensor

docs/            architecture, the anti-bot writeup, ADRs
```

---

## Requirements

Docker with Compose v2. That's it — the toolchains all run in containers.

First build pulls Chromium and a JDK, so it takes a few minutes. After that,
`make demo` is about a minute end to end.
