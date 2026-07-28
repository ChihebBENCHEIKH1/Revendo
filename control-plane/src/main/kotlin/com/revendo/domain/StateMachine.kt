package com.revendo.domain

import kotlin.math.min
import kotlin.math.pow
import kotlin.random.Random
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds

/**
 * The listing lifecycle, as a pure function.
 *
 * ## Why this is pure
 *
 * `transition` takes a state and an event and returns the next state plus a list of
 * [Effect]s that *describe* what should happen. It performs no IO: it does not
 * publish to RabbitMQ, does not touch Redis, does not read the clock and does not
 * generate randomness. Both come in as parameters.
 *
 * Functional core, imperative shell. The payoff is concrete:
 *
 *  - **The interesting logic is testable without infrastructure.** Every transition,
 *    every retry decision and every terminal condition is asserted in
 *    StateMachineTest with no broker, no Redis and no clock — so those tests run in
 *    milliseconds and never flake.
 *  - **Effects are inspectable before they happen.** A test can assert "this event
 *    schedules a retry 4 seconds out" rather than "eventually, something appears on a
 *    queue".
 *  - **Retries cannot be double-fired.** The decision to retry is made in one place
 *    and returned as data; there is no path where a handler both updates the state
 *    and separately decides to enqueue.
 *
 * ## Why illegal transitions are values, not exceptions
 *
 * A worker result for a listing that has already been cancelled is *normal* — it is
 * a race between a user action and an in-flight job, and it happens constantly at any
 * real volume. Throwing would turn an expected condition into an error to be caught
 * and inspected by string matching. Returning [TransitionResult.Illegal] makes the
 * caller decide, with the from-state and the event in hand.
 */
sealed interface ListingEvent {
    /** Seller submitted the listing for publication. */
    data object Submitted : ListingEvent

    /** A worker has claimed the job and started driving a browser. */
    data class WorkerStarted(val attempt: Int) : ListingEvent

    data class PublishSucceeded(val marketplaceId: String) : ListingEvent

    /** Interstitial served and not cleared. Recoverable. */
    data class PublishChallenged(val suspicionScore: Int) : ListingEvent

    /** Refused outright. The identity is burned. */
    data class PublishBlocked(val suspicionScore: Int, val reasons: List<String>) : ListingEvent

    /** Infrastructure or page-level failure — a timeout, a crashed renderer, a changed DOM. */
    data class PublishFailed(val error: String) : ListingEvent

    /** A scheduled retry came due. */
    data object RetryDue : ListingEvent

    data class OfferReceived(val offer: Offer) : ListingEvent

    data class OfferAccepted(val priceCents: Long) : ListingEvent

    data class CounterOffered(val amountCents: Long) : ListingEvent

    /** Seller gave up or pulled the item. */
    data class Cancelled(val reason: String) : ListingEvent
}

/**
 * Something the shell must do as a consequence of a transition.
 *
 * Effects are data, so they can be logged, asserted on and — crucially — deduplicated
 * or reordered by the caller without the state machine knowing or caring.
 */
sealed interface Effect {
    data class EnqueuePublish(val listingId: String, val attempt: Int, val idempotencyKey: String) : Effect
    data class ScheduleRetry(val listingId: String, val attempt: Int, val delay: Duration, val cause: String) : Effect
    data class RetireIdentity(val listingId: String, val reason: String) : Effect
    data class RequestNegotiation(val listingId: String, val offer: Offer, val floorCents: Long) : Effect
    data class RecordMetric(val name: String, val tags: Map<String, String> = emptyMap()) : Effect
    data class NotifySeller(val listingId: String, val message: String) : Effect
}

sealed interface TransitionResult {
    data class Ok(val next: ListingState, val effects: List<Effect>) : TransitionResult

    /**
     * The event does not apply in this state.
     *
     * Almost always a benign race, not a bug — which is exactly why it is a return
     * value the caller can log and ack rather than an exception that unwinds a
     * message handler.
     */
    data class Illegal(val from: ListingState, val event: ListingEvent) : TransitionResult
}

/**
 * Retry policy.
 *
 * Exponential backoff with **full jitter**. The jitter is not a detail: without it,
 * every job that failed in the same incident retries at the same instant, and the
 * retry storm re-creates the outage that caused the failures. Full jitter — a
 * uniform draw over `[0, base·2^n]` rather than a small wobble around it — is the
 * variant that spreads load best (AWS's "Exponential Backoff and Jitter", 2015).
 *
 * `maxAttempts` is low on purpose. Against an anti-bot system, retrying is not free
 * and not neutral: each attempt spends an identity and adds evidence to the target's
 * model of you. Ten retries do not get the listing published, they get the account
 * banned. This is the main way retry policy against a hostile target differs from
 * retry policy against a flaky one.
 */
data class RetryPolicy(
    val maxAttempts: Int = 3,
    val base: Duration = 2.seconds,
    val cap: Duration = 300.seconds,
) {
    fun shouldRetry(attempt: Int): Boolean = attempt < maxAttempts

    fun delayFor(attempt: Int, random: Random): Duration {
        val exponential = base.inWholeMilliseconds.toDouble() * 2.0.pow(attempt)
        val ceiling = min(exponential, cap.inWholeMilliseconds.toDouble())
        // Full jitter: uniform over [0, ceiling].
        return (random.nextDouble() * ceiling).milliseconds
    }
}

/**
 * Everything the transition needs from the outside world, passed in so the function
 * itself stays pure and therefore deterministic under test.
 */
data class TransitionContext(
    val nowEpochMs: Long,
    val random: Random,
    val retryPolicy: RetryPolicy = RetryPolicy(),
    val floorCents: Long = 0,
)

fun transition(
    listingId: String,
    current: ListingState,
    event: ListingEvent,
    ctx: TransitionContext,
): TransitionResult {
    val illegal = TransitionResult.Illegal(current, event)

    // Cancellation applies from any non-terminal state, so it is handled before the
    // main dispatch rather than repeated in every branch.
    if (event is ListingEvent.Cancelled) {
        return if (current is ListingState.Sold || current is ListingState.Failed) {
            illegal
        } else {
            TransitionResult.Ok(
                ListingState.Failed(reason = "cancelled: ${event.reason}", attempts = attemptsOf(current), atEpochMs = ctx.nowEpochMs),
                listOf(Effect.RecordMetric("listing.cancelled")),
            )
        }
    }

    return when (current) {
        is ListingState.Draft -> when (event) {
            is ListingEvent.Submitted -> TransitionResult.Ok(
                ListingState.Queued(attempt = 0),
                listOf(
                    Effect.EnqueuePublish(listingId, attempt = 0, idempotencyKey = idempotencyKey(listingId, 0)),
                    Effect.RecordMetric("listing.queued"),
                ),
            )
            else -> illegal
        }

        is ListingState.Queued -> when (event) {
            is ListingEvent.WorkerStarted -> TransitionResult.Ok(
                ListingState.Publishing(attempt = event.attempt, startedAtEpochMs = ctx.nowEpochMs),
                listOf(Effect.RecordMetric("listing.publishing")),
            )
            // The broker can redeliver, and a worker can die between claiming a job
            // and reporting. Terminal results arriving while still Queued are
            // therefore expected, not corrupt — accept them.
            is ListingEvent.PublishSucceeded,
            is ListingEvent.PublishBlocked,
            is ListingEvent.PublishChallenged,
            is ListingEvent.PublishFailed,
            -> transition(listingId, ListingState.Publishing(current.attempt, ctx.nowEpochMs), event, ctx)
            else -> illegal
        }

        is ListingState.Publishing -> when (event) {
            is ListingEvent.PublishSucceeded -> TransitionResult.Ok(
                ListingState.Published(event.marketplaceId, ctx.nowEpochMs),
                listOf(
                    Effect.RecordMetric("listing.published", mapOf("attempt" to current.attempt.toString())),
                    Effect.NotifySeller(listingId, "Listing is live"),
                ),
            )

            is ListingEvent.PublishChallenged -> retryOrFail(
                listingId = listingId,
                attempt = current.attempt,
                cause = "challenged (score ${event.suspicionScore})",
                ctx = ctx,
                onExhausted = ListingState.Challenged(event.suspicionScore, ctx.nowEpochMs),
                extraEffects = listOf(Effect.RecordMetric("listing.challenged")),
            )

            is ListingEvent.PublishBlocked -> {
                // A block is terminal for this identity, and retrying immediately with
                // the same one is the single worst thing to do — it confirms the
                // target's classification for free. Burn it, then decide whether the
                // listing gets another attempt with a fresh one.
                val burn = Effect.RetireIdentity(listingId, "blocked with score ${event.suspicionScore}")
                retryOrFail(
                    listingId = listingId,
                    attempt = current.attempt,
                    cause = "blocked (score ${event.suspicionScore})",
                    ctx = ctx,
                    onExhausted = ListingState.Blocked(event.suspicionScore, event.reasons, ctx.nowEpochMs),
                    extraEffects = listOf(burn, Effect.RecordMetric("listing.blocked")),
                )
            }

            is ListingEvent.PublishFailed -> retryOrFail(
                listingId = listingId,
                attempt = current.attempt,
                cause = event.error,
                ctx = ctx,
                onExhausted = ListingState.Failed(event.error, current.attempt + 1, ctx.nowEpochMs),
                extraEffects = listOf(Effect.RecordMetric("listing.publish_failed")),
            )

            else -> illegal
        }

        is ListingState.RetryScheduled -> when (event) {
            is ListingEvent.RetryDue -> TransitionResult.Ok(
                ListingState.Queued(attempt = current.attempt),
                listOf(
                    Effect.EnqueuePublish(listingId, current.attempt, idempotencyKey(listingId, current.attempt)),
                    Effect.RecordMetric("listing.retry_enqueued"),
                ),
            )
            else -> illegal
        }

        is ListingState.Published -> when (event) {
            is ListingEvent.OfferReceived -> TransitionResult.Ok(
                ListingState.Negotiating(current.marketplaceId, listOf(event.offer), ctx.floorCents),
                listOf(
                    Effect.RequestNegotiation(listingId, event.offer, ctx.floorCents),
                    Effect.RecordMetric("listing.negotiation_started"),
                ),
            )
            is ListingEvent.OfferAccepted -> TransitionResult.Ok(
                ListingState.Sold(current.marketplaceId, event.priceCents, ctx.nowEpochMs),
                listOf(Effect.RecordMetric("listing.sold")),
            )
            else -> illegal
        }

        is ListingState.Negotiating -> when (event) {
            is ListingEvent.OfferReceived -> TransitionResult.Ok(
                current.copy(offers = current.offers + event.offer),
                listOf(
                    Effect.RequestNegotiation(listingId, event.offer, current.floorCents),
                    Effect.RecordMetric("listing.offer_received"),
                ),
            )
            is ListingEvent.CounterOffered -> TransitionResult.Ok(
                current,
                listOf(Effect.RecordMetric("listing.countered")),
            )
            is ListingEvent.OfferAccepted ->
                // The floor is enforced here, in the state machine, not in the
                // negotiation model's prompt. A model can be argued out of a number in
                // its context; a `when` branch cannot.
                if (event.priceCents < current.floorCents) {
                    TransitionResult.Ok(
                        current,
                        listOf(
                            Effect.RecordMetric("listing.below_floor_rejected"),
                            Effect.NotifySeller(listingId, "Rejected an offer below your floor"),
                        ),
                    )
                } else {
                    TransitionResult.Ok(
                        ListingState.Sold(current.marketplaceId, event.priceCents, ctx.nowEpochMs),
                        listOf(Effect.RecordMetric("listing.sold")),
                    )
                }
            else -> illegal
        }

        // Terminal and quiescent states accept nothing further. Listed explicitly
        // rather than swept up in an `else`, so adding a state to the hierarchy breaks
        // this `when` at compile time and forces a decision here.
        is ListingState.Challenged,
        is ListingState.Blocked,
        is ListingState.Sold,
        is ListingState.Failed,
        -> illegal
    }
}

/**
 * Shared retry decision.
 *
 * Every failure path funnels through here so backoff, the attempt ceiling and the
 * terminal state are decided in exactly one place. Duplicating this per branch is how
 * one failure mode quietly ends up with a different retry budget than the others.
 */
private fun retryOrFail(
    listingId: String,
    attempt: Int,
    cause: String,
    ctx: TransitionContext,
    onExhausted: ListingState,
    extraEffects: List<Effect>,
): TransitionResult {
    val nextAttempt = attempt + 1
    if (!ctx.retryPolicy.shouldRetry(nextAttempt)) {
        return TransitionResult.Ok(
            onExhausted,
            extraEffects + Effect.RecordMetric("listing.retries_exhausted"),
        )
    }

    val delay = ctx.retryPolicy.delayFor(nextAttempt, ctx.random)
    return TransitionResult.Ok(
        ListingState.RetryScheduled(
            attempt = nextAttempt,
            notBeforeEpochMs = ctx.nowEpochMs + delay.inWholeMilliseconds,
            cause = cause,
        ),
        extraEffects + Effect.ScheduleRetry(listingId, nextAttempt, delay, cause),
    )
}

private fun attemptsOf(state: ListingState): Int = when (state) {
    is ListingState.Queued -> state.attempt
    is ListingState.Publishing -> state.attempt
    is ListingState.RetryScheduled -> state.attempt
    else -> 0
}

/**
 * Idempotency key for a publish attempt.
 *
 * Deterministic in `(listingId, attempt)` so a redelivered message produces the same
 * key and is recognised as a duplicate. Including the attempt is what allows a
 * *deliberate* retry to proceed while an *accidental* redelivery of the same attempt
 * is suppressed — a key on listingId alone would block both.
 */
fun idempotencyKey(listingId: String, attempt: Int): String = "publish:$listingId:$attempt"
