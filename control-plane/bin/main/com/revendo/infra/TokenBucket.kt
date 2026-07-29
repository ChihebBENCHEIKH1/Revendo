package com.revendo.infra

import io.lettuce.core.ScriptOutputType
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds

/**
 * Distributed token bucket, keyed per marketplace.
 *
 * This is the control plane's own governor — the thing that stops a fleet of workers
 * from hammering a marketplace faster than a human population would. It is the same
 * mechanism Vitrine uses defensively, applied here offensively, which is the point:
 * the cheapest way to stay under a rate limit is to know exactly what shape it has.
 *
 * ## Why Lua
 *
 * The obvious implementation — `GET` the count, decide in Kotlin, `SET` it back — is
 * a read-modify-write race. With N workers it admits roughly N extra requests per
 * window, and the failure only appears under the concurrency the limiter exists to
 * handle. Redis runs a script atomically against its keyspace, so refill, check and
 * consume cannot interleave.
 *
 * ## Why continuous refill rather than fixed windows
 *
 * A fixed window lets a client spend its entire budget at 0:59 and its entire next
 * budget at 1:01 — double the intended rate across the boundary, precisely the burst
 * a limiter is meant to prevent. Continuous refill has no boundary to exploit.
 *
 * The script returns the wait time as well as the verdict, so a caller that is
 * refused knows exactly how long to sleep instead of polling.
 */
class TokenBucket(private val redis: Redis) {

    data class Decision(val allowed: Boolean, val tokensRemaining: Long, val retryAfter: Duration)

    /**
     * KEYS[1] bucket
     * ARGV[1] capacity, ARGV[2] refill/sec, ARGV[3] now(ms), ARGV[4] cost
     * → { allowed, tokens_remaining, retry_after_ms }
     */
    private val script = """
        local key      = KEYS[1]
        local capacity = tonumber(ARGV[1])
        local rate     = tonumber(ARGV[2])
        local now      = tonumber(ARGV[3])
        local cost     = tonumber(ARGV[4])

        local state  = redis.call('HMGET', key, 'tokens', 'ts')
        local tokens = tonumber(state[1])
        local ts     = tonumber(state[2])

        if tokens == nil then
          tokens = capacity
          ts = now
        end

        local elapsed = math.max(0, now - ts) / 1000.0
        tokens = math.min(capacity, tokens + elapsed * rate)

        local allowed = 0
        local retry_after = 0
        if tokens >= cost then
          tokens = tokens - cost
          allowed = 1
        else
          -- Tell the caller exactly how long until the next token, so it can wait
          -- once instead of polling in a loop.
          retry_after = math.ceil(((cost - tokens) / rate) * 1000)
        end

        redis.call('HSET', key, 'tokens', tokens, 'ts', now)
        redis.call('PEXPIRE', key, math.ceil((capacity / rate) * 2000))

        return { allowed, math.floor(tokens), retry_after }
    """.trimIndent()

    suspend fun tryConsume(
        marketplace: String,
        capacity: Long,
        refillPerSecond: Double,
        nowEpochMs: Long,
        cost: Long = 1,
    ): Decision {
        @Suppress("UNCHECKED_CAST")
        val result = redis.commands.eval<List<Long>>(
            script,
            ScriptOutputType.MULTI,
            arrayOf("revendo:bucket:$marketplace"),
            capacity.toString(),
            refillPerSecond.toString(),
            nowEpochMs.toString(),
            cost.toString(),
        ).await()

        return Decision(
            allowed = result[0] == 1L,
            tokensRemaining = result[1],
            retryAfter = result[2].milliseconds,
        )
    }
}
