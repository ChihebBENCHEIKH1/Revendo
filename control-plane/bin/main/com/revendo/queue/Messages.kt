package com.revendo.queue

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json

/**
 * The wire contract between the Kotlin control plane and the TypeScript workers.
 *
 * Two independently-deployed services in two languages share these shapes, so the
 * rules that keep that survivable are encoded in the [WireJson] configuration below
 * rather than left to discipline.
 */

@Serializable
data class PublishJobMessage(
    val jobId: String,
    val listingId: String,
    val attempt: Int = 0,
    val payload: ListingPayload,
)

@Serializable
data class ListingPayload(
    val title: String,
    val brand: String,
    val size: String,
    val condition: String,
    val priceEur: Double,
    val description: String = "",
)

/**
 * Worker outcome.
 *
 * A closed union with a `kind` discriminator, mirroring the TypeScript
 * `PublishOutcome` exactly. The discriminator is what lets the control plane `when`
 * over the result exhaustively instead of inspecting nullable fields to guess what
 * happened.
 */
@Serializable
sealed interface PublishOutcome {
    @Serializable
    @SerialName("published")
    data class Published(val marketplaceId: String, val score: Int, val verdict: String) : PublishOutcome

    @Serializable
    @SerialName("challenged")
    data class Challenged(val solved: Boolean, val score: Int, val verdict: String) : PublishOutcome

    @Serializable
    @SerialName("blocked")
    data class Blocked(val score: Int, val verdict: String, val reasons: List<String> = emptyList()) : PublishOutcome

    @Serializable
    @SerialName("failed")
    data class Failed(val error: String) : PublishOutcome
}

@Serializable
data class PublishResultMessage(
    val jobId: String,
    val listingId: String,
    val workerId: String = "unknown",
    val profile: String = "unknown",
    val identity: String? = null,
    val egressIp: String? = null,
    val durationMs: Long = 0,
    val outcome: PublishOutcome,
)

/**
 * JSON settings for everything crossing a service boundary.
 *
 * - `ignoreUnknownKeys` — the producer must be free to add a field without a
 *   coordinated deploy of every consumer. Without this, additive changes are breaking
 *   changes and schema evolution requires a maintenance window.
 * - `classDiscriminator = "kind"` — matches the TypeScript union's tag exactly, so
 *   neither side needs a translation layer.
 * - `encodeDefaults` — a field with a default is still written, so a consumer that
 *   does *not* have that default reads the intended value instead of its own.
 * - `explicitNulls = false` — omit nulls rather than writing them; a smaller message
 *   and no ambiguity between "absent" and "explicitly null" on the wire.
 */
val WireJson: Json = Json {
    ignoreUnknownKeys = true
    classDiscriminator = "kind"
    encodeDefaults = true
    explicitNulls = false
}
