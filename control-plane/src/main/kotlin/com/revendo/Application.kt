package com.revendo

import com.revendo.api.ErrorResponse
import com.revendo.api.listingRoutes
import com.revendo.config.AppConfig
import com.revendo.domain.RetryPolicy
import com.revendo.infra.IdempotencyStore
import com.revendo.infra.ListingRepository
import com.revendo.infra.Redis
import com.revendo.infra.TokenBucket
import com.revendo.negotiation.ClaudeNegotiationAgent
import com.revendo.queue.Broker
import com.revendo.queue.ResultConsumer
import com.revendo.service.ListingService
import io.ktor.http.HttpStatusCode
import io.ktor.serialization.kotlinx.json.json
import io.ktor.server.application.Application
import io.ktor.server.application.install
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.plugins.BadRequestException
import io.ktor.server.plugins.callid.CallId
import io.ktor.server.plugins.callid.callIdMdc
import io.ktor.server.plugins.calllogging.CallLogging
import io.ktor.server.plugins.contentnegotiation.ContentNegotiation
import io.ktor.server.plugins.statuspages.StatusPages
import io.ktor.server.response.respond
import io.ktor.server.response.respondText
import io.ktor.server.routing.get
import io.ktor.server.routing.routing
import io.micrometer.prometheusmetrics.PrometheusConfig
import io.micrometer.prometheusmetrics.PrometheusMeterRegistry
import kotlinx.coroutines.CoroutineName
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import org.slf4j.LoggerFactory
import java.util.UUID

private val logger = LoggerFactory.getLogger("com.revendo.Application")

/**
 * Typed responses rather than `mapOf("ok" to true, "service" to "…")`.
 *
 * kotlinx.serialization has no serializer for a heterogeneous `Map<String, Any>` and
 * fails at runtime with "Serializing collections of different element types is not
 * yet supported" — a 500 on the health endpoint, which is the one endpoint that must
 * never lie about the service being up. A data class makes it a compile-time concern.
 */
@kotlinx.serialization.Serializable
private data class HealthResponse(val ok: Boolean, val service: String)

@kotlinx.serialization.Serializable
private data class ReadinessResponse(val ok: Boolean, val redis: Boolean)

fun main() {
    val config = AppConfig.fromEnvironment()

    val redis = Redis(config.redisUrl)
    val broker = Broker(config.rabbitUrl)
    val metrics = PrometheusMeterRegistry(PrometheusConfig.DEFAULT)

    /**
     * The application's coroutine scope.
     *
     * A `SupervisorJob` rather than a plain `Job`: one failed background task —
     * a negotiation call that throws, a result handler that dies — must not cancel
     * every sibling and take the service down with it. With a regular Job, a single
     * unhandled exception in a detached `launch` cancels the parent and therefore
     * everything else running under it.
     *
     * Everything launched from here is cancelled together on shutdown, which is the
     * other half of the deal: no orphaned coroutine outlives the process's decision
     * to stop.
     */
    val appScope = CoroutineScope(SupervisorJob() + CoroutineName("revendo-control-plane"))

    val repository = ListingRepository(redis)
    val service = ListingService(
        repository = repository,
        broker = broker,
        idempotency = IdempotencyStore(redis),
        rateLimiter = TokenBucket(redis),
        negotiation = ClaudeNegotiationAgent.fromEnvironmentOrStub(config.anthropicModel),
        metrics = metrics,
        scope = appScope,
        retryPolicy = RetryPolicy(maxAttempts = config.maxPublishAttempts),
        marketplaceCapacity = config.marketplaceCapacity,
        marketplaceRefillPerSecond = config.marketplaceRefillPerSecond,
    )

    val consumer = ResultConsumer(broker, service, appScope)
    consumer.start()

    val server = embeddedServer(Netty, port = config.port, host = "0.0.0.0") {
        module(service, redis, metrics)
    }

    // Shutdown order is the reverse of startup: stop taking work, then let in-flight
    // work finish, then close the connections it was using.
    Runtime.getRuntime().addShutdownHook(
        Thread {
            logger.info("shutting down")
            runCatching { consumer.close() }
            server.stop(gracePeriodMillis = 2_000, timeoutMillis = 8_000)
            appScope.cancel("application shutting down")
            runCatching { broker.close() }
            runCatching { redis.close() }
            logger.info("shutdown complete")
        },
    )

    logger.info("control plane listening on :{}", config.port)
    server.start(wait = true)
}

fun Application.module(
    service: ListingService,
    redis: Redis,
    metrics: PrometheusMeterRegistry,
) {
    install(ContentNegotiation) {
        json(
            Json {
                // Additive schema changes must not break clients that have not been
                // redeployed. This is the same reasoning as the wire format between the
                // control plane and the workers.
                ignoreUnknownKeys = true
                encodeDefaults = true
                explicitNulls = false
                prettyPrint = true
                // Matches the discriminator the TypeScript workers use, so the sealed
                // ListingState serializes to a shape a JS client can `switch` over.
                classDiscriminator = "kind"
            },
        )
    }

    install(CallId) {
        // Honour an inbound correlation id so a request can be traced across the
        // control plane, the broker and the workers; mint one when there isn't one.
        header("X-Request-Id")
        generate { UUID.randomUUID().toString() }
        verify { it.length in 8..128 }
    }

    install(CallLogging) {
        // Put the call id in the MDC so every log line emitted while handling this
        // request carries it, without every log statement having to remember to.
        callIdMdc("callId")
    }

    install(io.ktor.server.metrics.micrometer.MicrometerMetrics) {
        registry = metrics
    }

    /**
     * One place where exceptions become HTTP responses.
     *
     * Without this, a deserialization failure surfaces as a 500 with a stack trace,
     * which is both a bad API and an information leak. Note the shape: clients get a
     * stable error code, the details go to the log.
     */
    install(StatusPages) {
        exception<BadRequestException> { call, cause ->
            call.respond(HttpStatusCode.BadRequest, ErrorResponse("malformed_request", listOf(cause.message ?: "")))
        }
        exception<IllegalArgumentException> { call, cause ->
            call.respond(HttpStatusCode.UnprocessableEntity, ErrorResponse("invalid_argument", listOf(cause.message ?: "")))
        }
        exception<Throwable> { call, cause ->
            logger.error("unhandled exception", cause)
            call.respond(HttpStatusCode.InternalServerError, ErrorResponse("internal_error"))
        }
    }

    routing {
        listingRoutes(service, System::currentTimeMillis)

        get("/metrics") {
            call.respondText(metrics.scrape())
        }

        /**
         * Liveness vs readiness.
         *
         * `/healthz` answers "is this process alive" and must not touch dependencies —
         * a liveness probe that fails when Redis blips gets the pod restarted for a
         * problem a restart cannot fix. `/readyz` answers "can this process serve
         * traffic" and is where dependency checks belong.
         */
        get("/healthz") {
            call.respond(HealthResponse(ok = true, service = "control-plane"))
        }

        get("/readyz") {
            val redisOk = runCatching { redis.ping() == "PONG" }.getOrDefault(false)
            call.respond(
                if (redisOk) HttpStatusCode.OK else HttpStatusCode.ServiceUnavailable,
                ReadinessResponse(ok = redisOk, redis = redisOk),
            )
        }
    }
}

/** Convenience for tests and scripts that need a blocking entrypoint. */
internal fun blockingMain(block: suspend () -> Unit) = runBlocking { block() }
