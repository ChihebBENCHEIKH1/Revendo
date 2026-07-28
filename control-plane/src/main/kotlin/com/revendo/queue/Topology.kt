package com.revendo.queue

import com.rabbitmq.client.Channel
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds

/**
 * Broker topology, declared in one place and owned by the control plane.
 *
 * ## The retry ladder
 *
 * RabbitMQ has no native delayed delivery. The standard construction is a queue with
 * **no consumer**, a message TTL, and a dead-letter exchange pointing back at the
 * work queue: a message sits in the retry queue until its TTL expires, then RabbitMQ
 * dead-letters it — which delivers it back to the workers. A timer built out of the
 * two primitives the broker does have.
 *
 * ## Why tiers instead of per-message TTL
 *
 * Setting `expiration` per message and using one retry queue looks simpler and is a
 * trap. **Queues are FIFO, and dead-lettering only inspects the message at the head.**
 * A message with a 300s TTL at the head blocks a 2s message behind it for the full
 * 300 seconds. Under an incident — exactly when retries matter — the queue fills with
 * long-delay messages and every short retry stalls behind them.
 *
 * One queue per delay tier removes the interleaving entirely: within a tier every
 * message has the same TTL, so head-of-line order and expiry order agree. The state
 * machine's jittered backoff is rounded **up** to the nearest tier — rounding down
 * would let a retry storm arrive earlier than the policy intends, which defeats the
 * point of the backoff.
 *
 * The alternative is the `rabbitmq_delayed_message_exchange` plugin, which does
 * support arbitrary per-message delays. It is rejected here because it is a plugin
 * (not available on every managed broker), it holds pending messages in Mnesia rather
 * than a queue, and those messages are invisible to normal queue tooling. Four tiers
 * of standard AMQP work everywhere and can be inspected with the management UI.
 */
object Topology {
    const val JOBS_EXCHANGE = "revendo.jobs"
    const val RESULTS_EXCHANGE = "revendo.results"

    const val PUBLISH_QUEUE = "revendo.publish.q"
    const val PUBLISH_ROUTING_KEY = "publish"

    const val DLQ = "revendo.publish.dlq"
    const val DLQ_ROUTING_KEY = "publish.failed"

    const val RESULTS_QUEUE = "revendo.results.q"
    const val RESULT_ROUTING_KEY = "publish.result"

    /** Retry tiers. A jittered delay is rounded up to the first tier that covers it. */
    val RETRY_TIERS: List<Duration> = listOf(2.seconds, 10.seconds, 60.seconds, 300.seconds)

    fun retryQueue(tierIndex: Int) = "revendo.publish.retry.${tierIndex + 1}"
    fun retryRoutingKey(tierIndex: Int) = "retry.${tierIndex + 1}"

    /** First tier at least as long as `delay`; the last tier if none is. */
    fun tierFor(delay: Duration): Int {
        val index = RETRY_TIERS.indexOfFirst { it >= delay }
        return if (index >= 0) index else RETRY_TIERS.lastIndex
    }

    /**
     * Declare everything. Idempotent, and safe to run from every instance at boot.
     *
     * Declaration is intentionally not left to the workers. One service owning the
     * topology means one place where durability, dead-lettering and TTLs are decided;
     * if each consumer declared its own, a single mismatched argument would produce a
     * `PRECONDITION_FAILED` at some unrelated deploy and take a channel down with it.
     */
    fun declare(channel: Channel) {
        channel.exchangeDeclare(JOBS_EXCHANGE, "direct", true)
        channel.exchangeDeclare(RESULTS_EXCHANGE, "topic", true)

        // Work queue. Anything nacked without requeue lands on the DLQ for inspection
        // rather than vanishing.
        channel.queueDeclare(
            PUBLISH_QUEUE,
            true,
            false,
            false,
            mapOf(
                "x-dead-letter-exchange" to JOBS_EXCHANGE,
                "x-dead-letter-routing-key" to DLQ_ROUTING_KEY,
            ),
        )
        channel.queueBind(PUBLISH_QUEUE, JOBS_EXCHANGE, PUBLISH_ROUTING_KEY)

        // Retry tiers: no consumer, a TTL, and a dead-letter route back to the work
        // queue. The TTL is the timer and the DLX is the callback.
        RETRY_TIERS.forEachIndexed { index, delay ->
            channel.queueDeclare(
                retryQueue(index),
                true,
                false,
                false,
                mapOf(
                    "x-message-ttl" to delay.inWholeMilliseconds,
                    "x-dead-letter-exchange" to JOBS_EXCHANGE,
                    "x-dead-letter-routing-key" to PUBLISH_ROUTING_KEY,
                ),
            )
            channel.queueBind(retryQueue(index), JOBS_EXCHANGE, retryRoutingKey(index))
        }

        channel.queueDeclare(DLQ, true, false, false, null)
        channel.queueBind(DLQ, JOBS_EXCHANGE, DLQ_ROUTING_KEY)

        channel.queueDeclare(RESULTS_QUEUE, true, false, false, null)
        channel.queueBind(RESULTS_QUEUE, RESULTS_EXCHANGE, RESULT_ROUTING_KEY)
    }
}
