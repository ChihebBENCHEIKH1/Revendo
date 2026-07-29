package com.revendo.infra

import io.lettuce.core.SetArgs
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours

/**
 * At-most-once execution for operations that are not naturally idempotent.
 *
 * RabbitMQ delivers at-least-once. A worker that publishes a listing and dies before
 * acking will see the job again, and "publish this listing" is very much not
 * idempotent on the far side — the result is two identical listings on the
 * marketplace and a seller who has to delete one.
 *
 * `SET key value NX PX ttl` is the whole mechanism: atomic claim, and the TTL means
 * a crashed holder cannot wedge the key forever.
 *
 * ## The part that is easy to get wrong
 *
 * A naive implementation claims the key and returns. If the operation then *fails*,
 * the key is still held and the legitimate retry is suppressed — the job is lost, and
 * it is lost silently. So [withClaim] releases the claim on failure and keeps it only
 * on success. That turns the key from "someone tried this" into "this completed",
 * which is the property callers actually want.
 *
 * The remaining gap is honest and worth naming: a crash *between* completing the
 * operation and recording it still yields a duplicate. Closing that requires the
 * far side to accept an idempotency key of its own, which no marketplace offers.
 * The realistic mitigation is detection — check for an existing listing before
 * publishing — which is why the adapter reads the catalogue on arrival.
 */
class IdempotencyStore(private val redis: Redis, private val ttl: Duration = 24.hours) {

    sealed interface Claim {
        data object Acquired : Claim
        /** Someone else holds it — either in flight or already done. */
        data class AlreadyHeld(val holder: String) : Claim
    }

    suspend fun claim(key: String, holder: String): Claim {
        val ok = redis.commands.set(
            redisKey(key),
            holder,
            SetArgs.Builder.nx().px(ttl.inWholeMilliseconds),
        ).await()

        // Lettuce returns "OK" on success and null when NX rejected the write.
        return if (ok == "OK") {
            Claim.Acquired
        } else {
            Claim.AlreadyHeld(redis.commands.get(redisKey(key)).await() ?: "unknown")
        }
    }

    suspend fun release(key: String) {
        redis.commands.del(redisKey(key)).await()
    }

    /**
     * Run `block` at most once for `key`.
     *
     * Returns null when the claim was already held, so the caller can distinguish
     * "skipped as duplicate" from "ran and produced null".
     */
    suspend fun <T> withClaim(key: String, holder: String, block: suspend () -> T): T? {
        when (claim(key, holder)) {
            is Claim.AlreadyHeld -> return null
            is Claim.Acquired -> Unit
        }

        return try {
            block()
        } catch (e: Throwable) {
            // Release so a legitimate retry is not swallowed by our own bookkeeping.
            // Without this, one transient failure permanently suppresses the job.
            release(key)
            throw e
        }
    }

    private fun redisKey(key: String) = "revendo:idem:$key"
}
