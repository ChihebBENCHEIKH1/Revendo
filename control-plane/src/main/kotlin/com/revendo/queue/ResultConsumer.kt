package com.revendo.queue

import com.rabbitmq.client.Channel
import com.rabbitmq.client.DeliverCallback
import com.revendo.domain.ListingEvent
import com.revendo.service.ListingService
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.slf4j.LoggerFactory

/**
 * Consumes worker results and drives the state machine.
 *
 * The bridge between RabbitMQ's callback-threaded Java client and the service's
 * coroutine world is the interesting part. The broker delivers on its own thread
 * pool; suspending work cannot run there, so each delivery is `launch`ed on a
 * supervised scope and the ack happens only once the handler has actually finished.
 *
 * **Prefetch bounds the concurrency this creates.** Without it, `launch`-per-delivery
 * would happily start ten thousand coroutines from a backed-up queue — each holding
 * a Redis round-trip — and the broker would keep pushing because nothing has been
 * acked. Unacked-message count *is* the backpressure signal; prefetch is what makes
 * it one.
 */
class ResultConsumer(
    private val broker: Broker,
    private val service: ListingService,
    private val scope: CoroutineScope,
    private val prefetch: Int = 16,
) : AutoCloseable {

    private val logger = LoggerFactory.getLogger(ResultConsumer::class.java)
    private var channel: Channel? = null

    fun start() {
        val ch = broker.consumerChannel(prefetch)
        channel = ch

        val callback = DeliverCallback { _, delivery ->
            scope.launch {
                val tag = delivery.envelope.deliveryTag
                try {
                    handle(String(delivery.body, Charsets.UTF_8))
                    withContext(Dispatchers.IO) { ch.basicAck(tag, false) }
                } catch (e: Throwable) {
                    logger.error("failed to handle result, dead-lettering", e)
                    // requeue=false: a message that failed deterministically will fail
                    // again. Dead-lettering keeps it for inspection instead of spinning.
                    withContext(Dispatchers.IO) { runCatching { ch.basicNack(tag, false, false) } }
                }
            }
        }

        ch.basicConsume(Topology.RESULTS_QUEUE, false, callback) { consumerTag ->
            logger.warn("results consumer cancelled by broker: {}", consumerTag)
        }

        logger.info("consuming {} with prefetch {}", Topology.RESULTS_QUEUE, prefetch)
    }

    private suspend fun handle(body: String) {
        val result = WireJson.decodeFromString(PublishResultMessage.serializer(), body)

        // Translating a transport-layer result into a domain event is the only
        // mapping in this class. Everything after it is the state machine's problem,
        // which is exactly where the policy should live.
        val event = when (val outcome = result.outcome) {
            is PublishOutcome.Published -> ListingEvent.PublishSucceeded(outcome.marketplaceId)
            is PublishOutcome.Challenged -> ListingEvent.PublishChallenged(outcome.score)
            is PublishOutcome.Blocked -> ListingEvent.PublishBlocked(outcome.score, outcome.reasons)
            is PublishOutcome.Failed -> ListingEvent.PublishFailed(outcome.error)
        }

        logger.info(
            "result for listing {} from worker {} ({}): {}",
            result.listingId,
            result.workerId,
            result.profile,
            event::class.simpleName,
        )

        service.apply(result.listingId, event)
    }

    override fun close() {
        runCatching { channel?.close() }
    }
}
