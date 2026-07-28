# 0004 — Redis as the datastore, and the transactional gap that creates

**Status:** accepted, with a known limitation

## Context

The control plane changes a listing's state and then performs side effects: enqueue
a job, schedule a retry, burn an identity. Those two things need to happen together,
or not at all.

## Decision

Listings live in Redis, updated with a compare-and-set Lua script. Effects are
performed **after** the state is durably written.

## Why Redis

One datastore for the whole demo. Rate buckets, idempotency keys, identity
stickiness, session records and listings all need the same store, and `make demo`
should not require someone to wait through a Postgres migration to see a scraper get
blocked.

Compare-and-set rather than read-modify-write: two results for the same listing
arrive concurrently at any real volume — a retry racing a late original — and
last-writer-wins silently discards one of them. On a CAS miss the service re-reads
and re-decides, because the newer state may make the event illegal.

## The gap, stated plainly

**There is no transaction across the state write and the effects.** Ordering was
chosen to make the failure recoverable rather than to eliminate it:

| Order | Crash between the two leaves | Recoverable? |
|---|---|---|
| effects → persist | a worker publishing for a state change that was never recorded | **No** — the listing goes live and nothing knows |
| persist → effects | a listing in `Queued` with no job on the queue | **Yes** — a sweeper re-enqueues |

We take the second. A stuck listing is a bad outcome; a duplicate marketplace listing
the system has no record of is a worse one.

## What the real fix is

The **transactional outbox**. Postgres, and the state change plus an `outbox` row
committing in one transaction; a relay publishes from the outbox to RabbitMQ and
marks rows sent. The publish then becomes at-least-once *with* the state change
rather than beside it, and the idempotency key already in `StateMachine.kt` makes the
duplicate delivery harmless.

That was not built here because it needs a second datastore and a relay process, and
the demo's value is elsewhere. But an outbox is the answer to "how would you make
this correct", and pretending Redis had solved it would be worse than the gap.

## Consequences

- No cross-key transactions, no joins, no query planner. Listing lookups are
  `SMEMBERS` + N `HGET`, which is fine at demo scale and would not be at real scale.
- Redis persistence is off in compose, so `make down` is a clean slate. That is
  deliberate for a demo and wrong for anything else.
