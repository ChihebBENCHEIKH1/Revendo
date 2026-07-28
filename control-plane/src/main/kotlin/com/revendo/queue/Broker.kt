package com.revendo.queue

import com.rabbitmq.client.AMQP
import com.rabbitmq.client.Channel
import com.rabbitmq.client.Connection
import com.rabbitmq.client.ConnectionFactory
import com.rabbitmq.client.MessageProperties
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.slf4j.LoggerFactory
import kotlin.time.Duration

/**
 * RabbitMQ connection and publishing.
 *
 * Three things here are load-bearing and easy to get wrong.
 *
 * **1. Channels are not thread-safe.** The Java client documents this and enforces
 * nothing. Concurrent publishes on one channel interleave frames and corrupt the
 * stream, usually surfacing much later as an unintelligible protocol error. A single
 * publisher channel guarded by a [Mutex] is the simplest correct answer; a
 * channel-per-coroutine would also work but costs a channel per in-flight publish.
 *
 * **2. `basicPublish` is fire-and-forget by default.** It returns as soon as the
 * frame is written to the socket — before the broker has accepted it, let alone
 * persisted it. A broker that dies in that window loses the message with no error
 * anywhere. `confirmSelect` plus `waitForConfirmsOrDie` turns publishing into an
 * acknowledged operation, which is the entire point of using a durable broker.
 *
 * **3. The client API is blocking.** Every call is wrapped in `Dispatchers.IO` so it
 * never occupies a coroutine dispatcher thread that other work needs.
 */
class Broker(private val url: String) : AutoCloseable {

    private val logger = LoggerFactory.getLogger(Broker::class.java)

    private val connection: Connection = ConnectionFactory().apply {
        setUri(url)
        // Let the client reconnect rather than requiring a pod restart for a broker
        // blip. Topology is re-declared on recovery because it was declared durably.
        isAutomaticRecoveryEnabled = true
        networkRecoveryInterval = 3_000
        // A heartbeat is how a half-open TCP connection — a NAT timeout, a silently
        // dropped link — gets noticed instead of hanging forever.
        requestedHeartbeat = 20
    }.newConnection("revendo-control-plane")

    private val publishChannel: Channel = connection.createChannel().apply {
        // Turn publishing into an acknowledged operation.
        confirmSelect()
    }

    private val publishMutex = Mutex()

    init {
        connection.createChannel().use { Topology.declare(it) }
        logger.info("broker topology declared")
    }

    /** A dedicated channel for a consumer. Consumers must never share the publisher's. */
    fun consumerChannel(prefetch: Int): Channel =
        connection.createChannel().apply { basicQos(prefetch) }

    /**
     * Publish a publish-job, waiting for the broker to confirm it.
     *
     * `waitForConfirmsOrDie` throws if the broker nacks, so a failure to enqueue is a
     * failure the caller sees — not a message that quietly never existed.
     */
    suspend fun publishJob(message: PublishJobMessage) {
        val body = WireJson.encodeToString(PublishJobMessage.serializer(), message).toByteArray()
        publish(Topology.JOBS_EXCHANGE, Topology.PUBLISH_ROUTING_KEY, body, message.jobId)
    }

    /**
     * Park a job on the retry tier that covers `delay`.
     *
     * The message is not re-queued for workers — it goes to a queue with no consumer,
     * and the broker's TTL expiry is what eventually delivers it back.
     */
    suspend fun scheduleRetry(message: PublishJobMessage, delay: Duration) {
        val tier = Topology.tierFor(delay)
        val body = WireJson.encodeToString(PublishJobMessage.serializer(), message).toByteArray()
        logger.info(
            "scheduling retry for listing {} attempt {} on tier {} ({})",
            message.listingId,
            message.attempt,
            tier + 1,
            Topology.RETRY_TIERS[tier],
        )
        publish(Topology.JOBS_EXCHANGE, Topology.retryRoutingKey(tier), body, message.jobId)
    }

    private suspend fun publish(exchange: String, routingKey: String, body: ByteArray, correlationId: String) {
        withContext(Dispatchers.IO) {
            publishMutex.withLock {
                val props = AMQP.BasicProperties.Builder()
                    .contentType("application/json")
                    // deliveryMode 2 = persisted to disk. Without it, a durable queue
                    // still loses its contents when the broker restarts, which is a
                    // genuinely surprising interaction the first time it bites.
                    .deliveryMode(MessageProperties.PERSISTENT_TEXT_PLAIN.deliveryMode)
                    .correlationId(correlationId)
                    .timestamp(java.util.Date())
                    .build()

                publishChannel.basicPublish(exchange, routingKey, props, body)
                publishChannel.waitForConfirmsOrDie(10_000)
            }
        }
    }

    override fun close() {
        runCatching { publishChannel.close() }
        runCatching { connection.close() }
    }
}
