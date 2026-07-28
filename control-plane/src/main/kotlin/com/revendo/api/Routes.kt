package com.revendo.api

import com.revendo.domain.Listing
import com.revendo.domain.ListingEvent
import com.revendo.domain.Offer
import com.revendo.domain.TransitionResult
import com.revendo.service.ListingService
import io.ktor.http.HttpStatusCode
import io.ktor.server.application.call
import io.ktor.server.request.receive
import io.ktor.server.response.respond
import io.ktor.server.routing.Route
import io.ktor.server.routing.get
import io.ktor.server.routing.post
import io.ktor.server.routing.route
import kotlinx.serialization.Serializable

/**
 * HTTP surface.
 *
 * Thin on purpose: parse, validate, delegate, translate the result to a status
 * code. No business logic lives here — everything interesting is in the state
 * machine, and a route handler that starts making decisions is a route handler
 * that has stopped being testable without a web server.
 */

@Serializable
data class CreateListingRequest(
    val title: String,
    val brand: String,
    val size: String,
    val condition: String = "Très bon état",
    val priceCents: Long,
    /** Lowest acceptable price. Defaults to 70% of the ask. */
    val floorCents: Long? = null,
    val description: String = "",
) {
    fun validate(): List<String> = buildList {
        if (title.length !in 3..120) add("title must be 3-120 characters")
        if (brand.isBlank()) add("brand is required")
        if (priceCents <= 0) add("priceCents must be positive")
        // Money is in cents precisely so this comparison is exact. A floor above the
        // ask is not a rounding artefact, it is a contradiction.
        floorCents?.let { if (it > priceCents) add("floorCents cannot exceed priceCents") }
        floorCents?.let { if (it <= 0) add("floorCents must be positive") }
    }
}

@Serializable
data class OfferRequest(
    val buyerId: String,
    val amountCents: Long,
    val message: String = "",
)

@Serializable
data class ErrorResponse(val error: String, val details: List<String> = emptyList())

@Serializable
data class TransitionResponse(val listing: Listing, val effects: List<String>)

fun Route.listingRoutes(service: ListingService, clock: () -> Long) {
    route("/listings") {

        post {
            val request = call.receive<CreateListingRequest>()
            val problems = request.validate()
            if (problems.isNotEmpty()) {
                return@post call.respond(
                    HttpStatusCode.UnprocessableEntity,
                    ErrorResponse("invalid_listing", problems),
                )
            }

            val listing = service.create(
                title = request.title,
                brand = request.brand,
                size = request.size,
                condition = request.condition,
                priceCents = request.priceCents,
                // 70% is a sensible default rather than a meaningful one — it exists so
                // the field is optional, and the state machine still enforces whatever
                // value ends up here.
                floorCents = request.floorCents ?: (request.priceCents * 70 / 100),
                description = request.description,
            )

            // Creating and submitting are separate transitions so a draft can exist
            // without being queued. The API collapses them because that is what this
            // endpoint means; the domain keeps the distinction.
            service.apply(listing.id, ListingEvent.Submitted)

            call.respond(HttpStatusCode.Accepted, service.get(listing.id) ?: listing)
        }

        get {
            call.respond(service.all())
        }

        get("/{id}") {
            val id = call.parameters["id"]!!
            val listing = service.get(id)
                ?: return@get call.respond(HttpStatusCode.NotFound, ErrorResponse("listing_not_found"))
            call.respond(listing)
        }

        /**
         * Simulate a buyer offer.
         *
         * Present so the negotiation half of the lifecycle is reachable without a real
         * marketplace webhook. In production this is the inbound side of the same
         * message channel the worker reads from.
         */
        post("/{id}/offers") {
            val id = call.parameters["id"]!!
            val request = call.receive<OfferRequest>()
            if (request.amountCents <= 0) {
                return@post call.respond(
                    HttpStatusCode.UnprocessableEntity,
                    ErrorResponse("invalid_offer", listOf("amountCents must be positive")),
                )
            }

            val offer = Offer(
                buyerId = request.buyerId,
                amountCents = request.amountCents,
                atEpochMs = clock(),
                message = request.message,
            )

            when (val result = service.apply(id, ListingEvent.OfferReceived(offer))) {
                is TransitionResult.Illegal -> call.respond(
                    HttpStatusCode.Conflict,
                    ErrorResponse(
                        "illegal_transition",
                        listOf("cannot accept an offer while ${result.from::class.simpleName}"),
                    ),
                )
                is TransitionResult.Ok -> call.respond(
                    HttpStatusCode.Accepted,
                    TransitionResponse(
                        listing = service.get(id)!!,
                        effects = result.effects.map { it::class.simpleName ?: "Effect" },
                    ),
                )
            }
        }

        post("/{id}/cancel") {
            val id = call.parameters["id"]!!
            when (service.apply(id, ListingEvent.Cancelled("cancelled by seller"))) {
                is TransitionResult.Illegal -> call.respond(
                    HttpStatusCode.Conflict,
                    ErrorResponse("illegal_transition", listOf("listing is already terminal")),
                )
                is TransitionResult.Ok -> call.respond(HttpStatusCode.OK, service.get(id)!!)
            }
        }
    }
}
