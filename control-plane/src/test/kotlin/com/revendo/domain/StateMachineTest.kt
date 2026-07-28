package com.revendo.domain

import kotlin.random.Random
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds

/**
 * The state machine is a pure function, so these tests need no broker, no Redis, no
 * clock and no coroutines. They run in milliseconds and cannot flake.
 *
 * That property is the point of the functional-core design, and it is why the
 * *interesting* logic — retry budgets, identity burning, floor enforcement — is
 * tested exhaustively here rather than sampled through an integration test.
 */
class StateMachineTest {

    private val listingId = "listing-1"
    private val ctx = TransitionContext(
        nowEpochMs = 1_700_000_000_000,
        // Fixed seed: the retry policy uses jitter, and a test that asserts on jittered
        // output needs a generator it controls. Same reasoning as the worker's Rng.
        random = Random(42),
        retryPolicy = RetryPolicy(maxAttempts = 3),
        floorCents = 10_000,
    )

    private fun transition(from: ListingState, event: ListingEvent, context: TransitionContext = ctx) =
        transition(listingId, from, event, context)

    // ---------------------------------------------------------------- happy path

    @Test
    fun `submitting a draft queues it and enqueues a publish job`() {
        val result = transition(ListingState.Draft, ListingEvent.Submitted)

        assertIs<TransitionResult.Ok>(result)
        assertEquals(ListingState.Queued(attempt = 0), result.next)

        val enqueue = result.effects.filterIsInstance<Effect.EnqueuePublish>().single()
        assertEquals(0, enqueue.attempt)
        assertEquals("publish:$listingId:0", enqueue.idempotencyKey)
    }

    @Test
    fun `a successful publish moves to Published and notifies the seller`() {
        val result = transition(
            ListingState.Publishing(attempt = 0, startedAtEpochMs = 0),
            ListingEvent.PublishSucceeded("mkt-abc123"),
        )

        assertIs<TransitionResult.Ok>(result)
        val next = assertIs<ListingState.Published>(result.next)
        assertEquals("mkt-abc123", next.marketplaceId)
        assertTrue(result.effects.any { it is Effect.NotifySeller })
    }

    // ------------------------------------------------------------------- retries

    @Test
    fun `a block schedules a retry and burns the identity`() {
        val result = transition(
            ListingState.Publishing(attempt = 0, startedAtEpochMs = 0),
            ListingEvent.PublishBlocked(suspicionScore = 94, reasons = listOf("navigator.webdriver === true")),
        )

        assertIs<TransitionResult.Ok>(result)
        val next = assertIs<ListingState.RetryScheduled>(result.next)
        assertEquals(1, next.attempt)

        // Burning the identity is the load-bearing part. Retrying a blocked publish
        // with the same fingerprint and the same IP just confirms the target's
        // classification for free.
        assertTrue(
            result.effects.any { it is Effect.RetireIdentity },
            "a blocked publish must retire the identity before retrying",
        )
        assertTrue(result.effects.any { it is Effect.ScheduleRetry })
    }

    @Test
    fun `retries stop at the configured ceiling and land on a terminal Blocked state`() {
        val lastAttempt = ctx.retryPolicy.maxAttempts - 1
        val result = transition(
            ListingState.Publishing(attempt = lastAttempt, startedAtEpochMs = 0),
            ListingEvent.PublishBlocked(suspicionScore = 88, reasons = listOf("bhv.click_without_movement")),
        )

        assertIs<TransitionResult.Ok>(result)
        val next = assertIs<ListingState.Blocked>(result.next)
        assertEquals(88, next.suspicionScore)

        assertTrue(
            result.effects.none { it is Effect.ScheduleRetry },
            "no retry may be scheduled once the budget is exhausted",
        )
        assertTrue(result.effects.any { it is Effect.RecordMetric && it.name == "listing.retries_exhausted" })
    }

    @Test
    fun `a due retry re-enqueues with an attempt-scoped idempotency key`() {
        val result = transition(
            ListingState.RetryScheduled(attempt = 2, notBeforeEpochMs = 0, cause = "blocked"),
            ListingEvent.RetryDue,
        )

        assertIs<TransitionResult.Ok>(result)
        assertEquals(ListingState.Queued(attempt = 2), result.next)

        // The attempt is part of the key so a deliberate retry proceeds while an
        // accidental redelivery of the *same* attempt is suppressed. A key on
        // listingId alone would block both.
        val enqueue = result.effects.filterIsInstance<Effect.EnqueuePublish>().single()
        assertEquals("publish:$listingId:2", enqueue.idempotencyKey)
    }

    @Test
    fun `backoff grows exponentially and stays within the cap`() {
        val policy = RetryPolicy(base = 2.seconds, cap = 60.seconds, maxAttempts = 10)
        val random = Random(7)

        // Full jitter draws uniformly over [0, base·2^n], so any single sample can be
        // small. Assert the ceiling — the invariant the policy actually guarantees —
        // rather than that each delay exceeds the last, which jitter does not promise.
        for (attempt in 0..9) {
            val ceiling = minOf(
                2_000.0 * Math.pow(2.0, attempt.toDouble()),
                60_000.0,
            )
            val delay = policy.delayFor(attempt, random)
            assertTrue(
                delay.inWholeMilliseconds <= ceiling.toLong() + 1,
                "attempt $attempt produced $delay, above its ceiling of ${ceiling}ms",
            )
            assertTrue(delay.inWholeMilliseconds >= 0)
        }
    }

    @Test
    fun `full jitter actually spreads retries rather than clustering`() {
        // The whole reason for jitter is that a fleet failing together must not retry
        // together. A policy that returned the same value every time would satisfy the
        // ceiling test above and still cause the retry storm it exists to prevent.
        val policy = RetryPolicy(base = 8.seconds, cap = 60.seconds)
        val random = Random(1234)
        val samples = List(200) { policy.delayFor(attempt = 2, random = random).inWholeMilliseconds }

        val distinct = samples.distinct().size
        assertTrue(distinct > 150, "expected well-spread delays, got only $distinct distinct values")

        // And they should populate the low end too, not just hover near the ceiling.
        val ceiling = 32_000L
        assertTrue(samples.any { it < ceiling / 4 }, "no short delays drawn — this is not full jitter")
        assertTrue(samples.any { it > ceiling / 2 }, "no long delays drawn — this is not full jitter")
    }

    // ----------------------------------------------------------------- the floor

    @Test
    fun `an offer below the floor is rejected even when something upstream accepted it`() {
        val negotiating = ListingState.Negotiating(
            marketplaceId = "mkt-1",
            offers = emptyList(),
            floorCents = 10_000,
        )

        val result = transition(negotiating, ListingEvent.OfferAccepted(priceCents = 9_999))

        assertIs<TransitionResult.Ok>(result)
        // Still negotiating — the sale did NOT happen.
        assertIs<ListingState.Negotiating>(result.next)
        assertTrue(result.effects.any { it is Effect.RecordMetric && it.name == "listing.below_floor_rejected" })
    }

    @Test
    fun `an offer exactly at the floor sells`() {
        val negotiating = ListingState.Negotiating("mkt-1", emptyList(), floorCents = 10_000)
        val result = transition(negotiating, ListingEvent.OfferAccepted(priceCents = 10_000))

        assertIs<TransitionResult.Ok>(result)
        val sold = assertIs<ListingState.Sold>(result.next)
        assertEquals(10_000, sold.priceCents)
    }

    // -------------------------------------------------------- illegal & cancels

    @Test
    fun `a result for a sold listing is illegal rather than an exception`() {
        val sold = ListingState.Sold("mkt-1", 12_000, atEpochMs = 0)
        val result = transition(sold, ListingEvent.PublishSucceeded("mkt-2"))

        // Expected under races between a user action and an in-flight job — so it is a
        // value the caller can log and ack, not an exception that unwinds a handler.
        val illegal = assertIs<TransitionResult.Illegal>(result)
        assertEquals(sold, illegal.from)
    }

    @Test
    fun `cancellation applies from every non-terminal state`() {
        val nonTerminal = listOf(
            ListingState.Draft,
            ListingState.Queued(0),
            ListingState.Publishing(0, 0),
            ListingState.Published("mkt-1", 0),
            ListingState.RetryScheduled(1, 0, "x"),
            ListingState.Negotiating("mkt-1", emptyList(), 10_000),
            ListingState.Challenged(45, 0),
            ListingState.Blocked(90, emptyList(), 0),
        )

        for (state in nonTerminal) {
            val result = transition(state, ListingEvent.Cancelled("seller pulled it"))
            assertIs<TransitionResult.Ok>(result, "cancel should be legal from ${state::class.simpleName}")
            assertIs<ListingState.Failed>(result.next)
        }
    }

    @Test
    fun `cancellation is illegal once the listing is terminal`() {
        val terminal = listOf(
            ListingState.Sold("mkt-1", 1, 0),
            ListingState.Failed("nope", 3, 0),
        )
        for (state in terminal) {
            assertIs<TransitionResult.Illegal>(
                transition(state, ListingEvent.Cancelled("too late")),
                "cancel should be illegal from ${state::class.simpleName}",
            )
        }
    }

    @Test
    fun `a terminal result arriving while still Queued is accepted, not dropped`() {
        // The broker redelivers, and a worker can die between claiming a job and
        // reporting it. A result that arrives before we recorded the Publishing
        // transition is normal traffic, not corruption.
        val result = transition(ListingState.Queued(attempt = 1), ListingEvent.PublishSucceeded("mkt-9"))

        assertIs<TransitionResult.Ok>(result)
        assertIs<ListingState.Published>(result.next)
    }

    @Test
    fun `idempotency keys are deterministic in listing and attempt`() {
        assertEquals(idempotencyKey("a", 2), idempotencyKey("a", 2))
        assertTrue(idempotencyKey("a", 2) != idempotencyKey("a", 3))
        assertTrue(idempotencyKey("a", 2) != idempotencyKey("b", 2))
    }
}
