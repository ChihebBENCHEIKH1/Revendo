# 0005 — Tiered retry queues, not per-message TTL

**Status:** accepted

## Context

RabbitMQ has no native delayed delivery, and the state machine produces jittered
backoff delays that need to become actual delays somewhere.

## Decision

Four queues with **no consumer**, message TTLs of 2s / 10s / 60s / 300s, each
dead-lettering back to the work queue. A jittered delay is rounded **up** to the
nearest tier.

## Why not per-message TTL

Setting `expiration` on each message and using one retry queue is simpler, and it is
a trap.

**Queues are FIFO, and dead-lettering only inspects the message at the head.** A
message with a 300s TTL sitting at the head blocks a 2s message behind it for the
full 300 seconds. The failure appears exactly when it hurts most: during an incident,
the queue fills with long-delay retries and every short retry stalls behind them.

One queue per tier removes the interleaving — within a tier every message has the
same TTL, so head-of-line order and expiry order agree.

## Why not the delayed-message plugin

`rabbitmq_delayed_message_exchange` supports arbitrary per-message delays and would
be the neatest answer. Rejected because:

- It is a plugin, and not available on every managed broker.
- Pending messages live in Mnesia rather than in a queue, so they are invisible to
  the management UI and to every queue-depth alert you already have.

Four tiers of standard AMQP work everywhere and can be watched in the management UI
during the demo.

## Why round up

Rounding down would let a retry arrive earlier than the policy intends, which defeats
the backoff. The cost is that a 3-second jittered delay waits 10 seconds; with full
jitter spreading delays across the range anyway, that granularity loss does not
change the property that matters — that failing jobs do not retry in lockstep.

## Consequences

- Four extra queues, declared once in `Topology.kt`.
- Delay granularity is coarse. If a workload needed precise backoff, the plugin — or
  a scheduler keyed on `notBeforeEpochMs`, which the state machine already records —
  would be the upgrade path.
- The DLQ is separate from the retry tiers, so "failed permanently" and "waiting to
  retry" are never confused in a queue-depth graph.
