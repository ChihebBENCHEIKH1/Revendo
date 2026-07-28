# 0003 — A pure state machine that returns effects

**Status:** accepted

## Context

The listing lifecycle carries the real business logic: when to retry, how long to
back off, when to burn an identity, when a sale is allowed. That logic is where bugs
are expensive and where tests are most valuable — and it is also the logic most
entangled with RabbitMQ, Redis, the clock and randomness.

## Decision

`transition(listingId, state, event, ctx)` is a **pure function** returning
`(nextState, List<Effect>)`. It performs no IO, reads no clock, and generates no
randomness — both come in through `TransitionContext`. `ListingService` is the
imperative shell that performs the effects.

## Why

- **The interesting logic tests without infrastructure.** Every transition, retry
  decision and terminal condition is asserted in `StateMachineTest` with no broker, no
  Redis and no coroutines. Those tests run in milliseconds and cannot flake.
- **Effects are inspectable before they happen.** A test asserts *"a block schedules a
  retry AND retires the identity"* by reading a list, rather than *"eventually,
  something appears on a queue"*.
- **Retries cannot double-fire.** The decision to retry is made in one place and
  returned as data. There is no path where a handler both updates state and separately
  decides to enqueue.
- **Illegal transitions are values, not exceptions.** A worker result for a cancelled
  listing is *normal* — it's a race between a user action and an in-flight job, and it
  happens constantly at volume. Returning `TransitionResult.Illegal` lets the caller
  log it and ack; throwing would turn an expected condition into an error inspected by
  string matching.

## Consequences

- The shell must remember to run the effects. Mitigated by there being exactly one
  place that does it (`runEffects`).
- `TransitionContext` has to carry the clock and the RNG, which looks like ceremony
  until you write the first test asserting on a jittered backoff.
- Adding a state breaks every `when` at compile time. That is the feature.
