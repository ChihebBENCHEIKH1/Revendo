package com.revendo.service

import com.revendo.domain.Effect
import com.revendo.domain.Listing
import com.revendo.domain.ListingEvent
import com.revendo.domain.ListingState
import com.revendo.domain.RetryPolicy
import com.revendo.domain.TransitionContext
import com.revendo.domain.TransitionResult
import com.revendo.domain.transition
import com.revendo.infra.IdempotencyStore
import com.revendo.infra.ListingRepository
import com.revendo.infra.TokenBucket
import com.revendo.negotiation.NegotiationAgent
import com.revendo.queue.Broker
import com.revendo.queue.ListingPayload
import com.revendo.queue.PublishJobMessage
import io.micrometer.core.instrument.MeterRegistry
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import org.slf4j.LoggerFactory
import java.util.UUID
import kotlin.random.Random

/**
 * The imperative shell around the pure state machine.
 *
 * The division of labour is strict and is the main architectural idea in this
 * service: `domain/StateMachine.kt` decides *what should happen* and returns it as
 * data; this class *makes it happen*. Nothing here decides policy, and nothing there
 * touches the network.
 *
 * That leaves this class with exactly three real jobs: resolve concurrent writers,
 * translate effects into IO, and make sure a crash between the two does not lose the
 * work. Each is handled explicitly below rather than left implicit.
 */
class ListingService(
    private val repository: ListingRepository,
    private val broker: Broker,
    private val idempotency: IdempotencyStore,
    private val rateLimiter: TokenBucket,
    private val negotiation: NegotiationAgent,
    private val metrics: MeterRegistry,
    private val scope: CoroutineScope,
    private val retryPolicy: RetryPolicy = RetryPolicy(),
    private val clock: () -> Long = System::currentTimeMillis,
    private val random: Random = Random.Default,
    private val marketplaceCapacity: Long = 20,
    private val marketplaceRefillPerSecond: Double = 0.4,
) {
    private val logger = LoggerFactory.getLogger(ListingService::class.java)

    suspend fun create(
        title: String,
        brand: String,
        size: String,
        condition: String,
        priceCents: Long,
        floorCents: Long,
        description: String,
    ): Listing {
        val now = clock()
        val listing = Listing(
            id = UUID.randomUUID().toString().take(8),
            title = title,
            brand = brand,
            size = size,
            condition = condition,
            priceCents = priceCents,
            description = description,
            floorCents = floorCents,
            state = ListingState.Draft,
            createdAtEpochMs = now,
            updatedAtEpochMs = now,
        )
        repository.save(listing)
        return listing
    }

    /**
     * Apply an event to a listing.
     *
     * ## Concurrency
     *
     * Two results for the same listing can arrive at once — a retry and a late
     * original, a redelivery racing a fresh delivery. The repository update is
     * compare-and-set, and a lost race re-reads and re-decides rather than retrying
     * the *write*: the newer state may make the event illegal, and blindly re-applying
     * would resurrect a listing the other writer just cancelled.
     *
     * ## Effect ordering
     *
     * Effects run **after** the state is durably written. The reverse order — enqueue
     * then persist — risks a worker picking up a job for a state transition that was
     * never recorded, which is unrecoverable. This ordering risks the opposite: a
     * crash after the write and before the enqueue leaves a listing stuck in `Queued`
     * with no job. That is recoverable by a sweeper, and a recoverable failure beats
     * an unrecoverable one. The real fix is a transactional outbox — see ADR 0004.
     */
    suspend fun apply(listingId: String, event: ListingEvent): TransitionResult {
        repeat(MAX_CAS_ATTEMPTS) { attempt ->
            val listing = repository.find(listingId)
                ?: return TransitionResult.Illegal(ListingState.Draft, event)
            val version = repository.version(listingId)

            val ctx = TransitionContext(
                nowEpochMs = clock(),
                random = random,
                retryPolicy = retryPolicy,
                floorCents = listing.floorCents,
            )

            when (val result = transition(listingId, listing.state, event, ctx)) {
                is TransitionResult.Illegal -> {
                    // Expected under races, so this is information, not an error. The
                    // caller acks the message; re-delivering it would produce the same
                    // outcome forever.
                    logger.info(
                        "ignoring {} for listing {} in state {}",
                        event::class.simpleName,
                        listingId,
                        listing.state::class.simpleName,
                    )
                    metrics.counter("listing.illegal_transition").increment()
                    return result
                }

                is TransitionResult.Ok -> {
                    val updated = listing.copy(state = result.next, updatedAtEpochMs = ctx.nowEpochMs)
                    if (!repository.update(updated, version)) {
                        logger.debug("CAS miss for listing {} (attempt {}), re-reading", listingId, attempt + 1)
                        metrics.counter("listing.cas_retry").increment()
                        return@repeat
                    }

                    runEffects(updated, result.effects)
                    return result
                }
            }
        }

        logger.warn("gave up updating listing {} after {} CAS attempts", listingId, MAX_CAS_ATTEMPTS)
        metrics.counter("listing.cas_exhausted").increment()
        return TransitionResult.Illegal(ListingState.Draft, event)
    }

    private suspend fun runEffects(listing: Listing, effects: List<Effect>) {
        for (effect in effects) {
            when (effect) {
                is Effect.EnqueuePublish -> enqueuePublish(listing, effect)

                is Effect.ScheduleRetry -> broker.scheduleRetry(
                    jobMessageFor(listing, effect.attempt),
                    effect.delay,
                )

                is Effect.RetireIdentity -> {
                    // The worker owns identity storage, so the control plane signals
                    // rather than reaches in. Modelled as an effect so the decision is
                    // visible in the state machine's output and assertable in a test.
                    logger.warn("retiring identity for listing {}: {}", listing.id, effect.reason)
                    metrics.counter("identity.retired").increment()
                }

                is Effect.RequestNegotiation -> scope.launch {
                    // Detached: an LLM round-trip must not hold up the message handler
                    // that triggered it. Launched on the application scope so shutdown
                    // cancels it rather than leaking.
                    negotiation.handleOffer(listing, effect.offer)
                }

                is Effect.RecordMetric ->
                    metrics.counter(effect.name, *effect.tags.flatMap { listOf(it.key, it.value) }.toTypedArray())
                        .increment()

                is Effect.NotifySeller ->
                    logger.info("notify seller for {}: {}", listing.id, effect.message)
            }
        }
    }

    /**
     * Enqueue a publish job, subject to the marketplace rate limit and idempotency.
     *
     * The rate limit is checked *before* the idempotency claim. Claiming first and
     * then discovering we are rate-limited would leave the key held by a job that
     * never ran, and the retry would be suppressed by our own bookkeeping.
     */
    private suspend fun enqueuePublish(listing: Listing, effect: Effect.EnqueuePublish) {
        val decision = rateLimiter.tryConsume(
            marketplace = MARKETPLACE,
            capacity = marketplaceCapacity,
            refillPerSecond = marketplaceRefillPerSecond,
            nowEpochMs = clock(),
        )

        if (!decision.allowed) {
            logger.info(
                "rate limit reached for {}, deferring listing {} by {}",
                MARKETPLACE,
                listing.id,
                decision.retryAfter,
            )
            metrics.counter("marketplace.rate_limited").increment()
            // Park it on the retry ladder rather than dropping it. The limiter told us
            // exactly how long to wait, so there is no polling.
            broker.scheduleRetry(jobMessageFor(listing, effect.attempt), decision.retryAfter)
            return
        }

        val claimed = idempotency.withClaim(effect.idempotencyKey, holder = "control-plane") {
            broker.publishJob(jobMessageFor(listing, effect.attempt))
        }

        if (claimed == null) {
            logger.info("duplicate publish suppressed for {}", effect.idempotencyKey)
            metrics.counter("listing.duplicate_suppressed").increment()
        }
    }

    private fun jobMessageFor(listing: Listing, attempt: Int) = PublishJobMessage(
        jobId = UUID.randomUUID().toString(),
        listingId = listing.id,
        attempt = attempt,
        payload = ListingPayload(
            title = listing.title,
            brand = listing.brand,
            size = listing.size,
            condition = listing.condition,
            priceEur = listing.priceCents / 100.0,
            description = listing.description,
        ),
    )

    suspend fun get(id: String): Listing? = repository.find(id)

    suspend fun all(): List<Listing> = repository.all()

    private companion object {
        const val MAX_CAS_ATTEMPTS = 5
        const val MARKETPLACE = "vitrine"
    }
}
