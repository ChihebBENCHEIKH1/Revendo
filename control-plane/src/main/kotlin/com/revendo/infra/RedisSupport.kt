package com.revendo.infra

import io.lettuce.core.RedisClient
import io.lettuce.core.api.StatefulRedisConnection
import io.lettuce.core.api.async.RedisAsyncCommands
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.suspendCancellableCoroutine
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CompletionStage
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * Bridge from Lettuce's `CompletionStage` API to coroutines.
 *
 * Written by hand rather than pulled from a helper library, because the interesting
 * part is the cancellation contract and it is four lines. When the calling coroutine
 * is cancelled — a client disconnects, a timeout fires, a supervising scope tears
 * down — the underlying future is cancelled too. Without `invokeOnCancellation`, a
 * cancelled coroutine leaves the Redis call running and its result is silently
 * discarded, which is how a service under load ends up with a connection pool full of
 * work nobody is waiting for.
 */
suspend fun <T> CompletionStage<T>.await(): T = suspendCancellableCoroutine { cont: CancellableContinuation<T> ->
    whenComplete { value, error ->
        when {
            // The continuation may already be cancelled; resume() on a cancelled
            // continuation is a no-op, so this is safe rather than merely convenient.
            error != null -> cont.resumeWithException(error)
            else -> cont.resume(value)
        }
    }
    cont.invokeOnCancellation {
        (this as? CompletableFuture<T>)?.cancel(false)
    }
}

/**
 * Owns the Redis connection.
 *
 * A single multiplexed connection, not a pool: Lettuce's connection is thread-safe
 * and pipelines concurrent commands over one socket, so a pool would add contention
 * and connection count for no throughput. Pools are for blocking clients.
 */
class Redis(uri: String) : AutoCloseable {
    private val client: RedisClient = RedisClient.create(uri)
    private val connection: StatefulRedisConnection<String, String> = client.connect()

    val commands: RedisAsyncCommands<String, String> = connection.async()

    suspend fun ping(): String = commands.ping().await()

    override fun close() {
        connection.close()
        client.shutdown()
    }
}
