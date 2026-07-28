# 0001 — Split the control plane from the data plane

**Status:** accepted

## Context

The system does two jobs: decide *what should be published, when, and how often*, and
*drive a browser to do it*. The obvious first design puts both in one service.

## Decision

Two services, two languages, connected by RabbitMQ.

- **Control plane** (Kotlin/Ktor) — listing lifecycle, retry policy, rate budget,
  idempotency, negotiation.
- **Workers** (TypeScript, raw CDP) — one browser context per job, disposable.

## Why

**They have opposite failure modes.** The orchestrator is IO-bound, holds all the
state, and must never die. A browser worker is a memory-hog that dies constantly —
renderer crashes, OOM kills, hung page loads — and *should* be disposable. Putting
them in one process means the thing that must not die shares a heap with the thing
that reliably OOMs.

**They have opposite scaling curves.** Orchestration scales with listings; browser
work scales with concurrent sessions, and each session costs hundreds of megabytes.
You want to add workers without adding orchestrators, and you cannot do that if
they're the same binary.

**The evasion payloads are JavaScript regardless.** Patching `navigator.webdriver`
ships as JS injected via `Page.addScriptToEvaluateOnNewDocument`. Writing the worker
in Kotlin would not have made that Kotlin — it would have added a translation layer
for no benefit. Meanwhile the control plane is exactly where a type system and a
sealed hierarchy earn their keep: illegal listing states become uncompilable rather
than untested.

## Consequences

- **Cost:** two toolchains, two Dockerfiles, a wire contract to keep in sync. The
  contract is pinned by a shared `kind` discriminator and `ignoreUnknownKeys` on both
  sides, so additive changes don't need a coordinated deploy.
- **Benefit:** a worker can be `SIGKILL`ed at any moment and the job is redelivered.
  That is the property that makes the whole thing operable.
- The DLQ and retry topology live in the control plane, so retry policy is decided in
  one place instead of reinvented per worker.
