# 0002 — Drive Chrome over raw CDP, not Playwright or Puppeteer

**Status:** accepted

## Context

Playwright and Puppeteer are excellent, well-maintained, and the default choice for
browser automation. Using one would have saved meaningful work.

## Decision

Drive Chrome directly over the DevTools Protocol via `chrome-remote-interface`.

## Why

**1. Header order is an ordered array.** `Fetch.continueRequest` takes
`Array<{name, value}>` — the only way to control the exact byte order Chrome puts on
the wire. Every higher-level API exposes headers as a *dictionary*, which has thrown
that information away before you ever see it. Header order is one of the cheapest
signals a defender has (see [ANTI-BOT.md](../ANTI-BOT.md)), so giving it up to save a
few lines is a bad trade.

**2. Input fidelity.** `Input.dispatchMouseEvent` at a chosen coordinate and a chosen
timestamp is the substrate the entire behaviour engine is built on. `page.click()` is
precisely the thing we are trying not to do.

**3. Surface control.** Frameworks add their own launch flags, injected bindings and
bridge objects — each a detectable artefact you did not choose and cannot easily
remove. A concrete win: driving Chrome directly never loads ChromeDriver, so the
entire `$cdc_*` artefact class (`fp.automation_artifacts`, weight 35) is avoided for
free rather than patched away.

## Consequences

- More code in `cdp/session.ts`: target/context lifecycle, navigation waits, element
  rects, event dispatch. Roughly 250 lines that a framework would have provided.
- No auto-waiting, no selector engine, no trace viewer. The adapter has to poll for
  selectors itself.
- In exchange: nothing between the code and the protocol, and every byte on the wire
  is a deliberate choice.

## Alternatives considered

- **Playwright + `playwright-extra` stealth plugins.** Rejected: the plugins are
  well-known and fingerprinted as a set, and several use exactly the naive
  `defineProperty` pattern that `fp.function_tostring_tampered` is built to catch.
- **Playwright with `route()` for headers.** `route()` fulfils with a header map; it
  cannot express ordering.
