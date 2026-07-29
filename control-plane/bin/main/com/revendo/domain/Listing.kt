package com.revendo.domain

import kotlinx.serialization.Serializable

/**
 * A listing's lifecycle, as a closed set of states.
 *
 * Modelled as a `sealed interface` rather than an enum plus a bag of nullable
 * columns, because the states genuinely carry different data. `Published` has a
 * marketplace id; `Draft` cannot have one. `Blocked` has a suspicion score and the
 * signals that produced it; `Sold` has a price. An enum forces all of that into
 * nullable fields on one class, and every read site then has to re-derive which
 * fields are meaningful — usually with a `!!` and a comment apologising for it.
 *
 * With a sealed hierarchy the compiler carries that knowledge instead:
 *
 *   - `when` over a `ListingState` with no `else` is checked for exhaustiveness, so
 *     adding a state turns every place that needs updating into a compile error
 *     rather than a runtime surprise.
 *   - `Published.marketplaceId` is non-null by construction, because a state that
 *     does not have one is a different type.
 *   - Illegal states are unrepresentable: there is no way to build a `Sold` without
 *     a price, or a `Blocked` without a score.
 */
@Serializable
sealed interface ListingState {

    /** Created locally, not yet submitted to any marketplace. */
    @Serializable
    data object Draft : ListingState

    /** Handed to the broker; a worker will pick it up. */
    @Serializable
    data class Queued(val attempt: Int) : ListingState

    /** A worker has it and is driving a browser. */
    @Serializable
    data class Publishing(val attempt: Int, val startedAtEpochMs: Long) : ListingState

    /** Live on the marketplace. */
    @Serializable
    data class Published(val marketplaceId: String, val atEpochMs: Long) : ListingState

    /**
     * The marketplace served an interstitial the worker could not clear.
     *
     * Distinct from [Blocked] on purpose. A challenge is recoverable with a better
     * behavioural profile or a warmer identity; a block means the identity is burned.
     * Collapsing them would throw away the only signal that says which of those two
     * very different remedies applies.
     */
    @Serializable
    data class Challenged(val suspicionScore: Int, val atEpochMs: Long) : ListingState

    /** Refused. The identity that earned this must not be reused. */
    @Serializable
    data class Blocked(
        val suspicionScore: Int,
        val reasons: List<String>,
        val atEpochMs: Long,
    ) : ListingState

    /** Waiting out a backoff before the next attempt. */
    @Serializable
    data class RetryScheduled(val attempt: Int, val notBeforeEpochMs: Long, val cause: String) : ListingState

    /** Published, and a buyer is haggling. */
    @Serializable
    data class Negotiating(
        val marketplaceId: String,
        val offers: List<Offer>,
        val floorCents: Long,
    ) : ListingState

    @Serializable
    data class Sold(val marketplaceId: String, val priceCents: Long, val atEpochMs: Long) : ListingState

    /** Terminal failure — retries exhausted, or an error no retry can fix. */
    @Serializable
    data class Failed(val reason: String, val attempts: Int, val atEpochMs: Long) : ListingState
}

@Serializable
data class Offer(
    val buyerId: String,
    val amountCents: Long,
    val atEpochMs: Long,
    val message: String = "",
)

@Serializable
data class Listing(
    val id: String,
    val title: String,
    val brand: String,
    val size: String,
    val condition: String,
    val priceCents: Long,
    val description: String,
    /**
     * Lowest price the seller will accept.
     *
     * Held in the control plane and never sent to the negotiation model as something
     * it may reveal — see NegotiationAgent, where it is enforced in code after the
     * model answers rather than requested of it in a prompt.
     */
    val floorCents: Long,
    val state: ListingState,
    val createdAtEpochMs: Long,
    val updatedAtEpochMs: Long,
) {
    /** True once the listing can no longer change on its own. */
    val isTerminal: Boolean
        get() = when (state) {
            is ListingState.Sold, is ListingState.Failed -> true
            else -> false
        }
}
