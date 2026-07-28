package com.revendo.infra

import com.revendo.domain.Listing
import com.revendo.domain.ListingState
import kotlinx.serialization.json.Json

/**
 * Listing persistence.
 *
 * Redis rather than Postgres, deliberately, and the trade-off is worth stating rather
 * than hiding: this keeps the demo to one datastore and one `docker compose up`, at
 * the cost of the thing a real version of this service would most want — transactions
 * across a state change and its side effects. A production control plane would put
 * listings in Postgres and use the transactional outbox pattern so a state change and
 * the message announcing it commit together. See docs/adr/0004.
 *
 * What is *not* compromised is the update path. [update] is compare-and-set via a Lua
 * script rather than read-modify-write, because two results for the same listing can
 * arrive concurrently — a retry and a late original, say — and last-writer-wins would
 * silently discard one of them.
 */
class ListingRepository(private val redis: Redis) {

    private val json = Json {
        // The listing schema will grow. A consumer that hard-fails on a field it does
        // not know about turns every additive change into a coordinated deploy.
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    /**
     * KEYS[1] listing key, KEYS[2] index key
     * ARGV[1] new document, ARGV[2] expected version
     * → 1 written, 0 version mismatch
     */
    private val casScript = """
        local current = redis.call('HGET', KEYS[1], 'version')
        if current and tonumber(current) ~= tonumber(ARGV[2]) then
          return 0
        end
        redis.call('HSET', KEYS[1], 'doc', ARGV[1], 'version', tonumber(ARGV[2]) + 1)
        redis.call('SADD', KEYS[2], ARGV[3])
        return 1
    """.trimIndent()

    suspend fun save(listing: Listing) {
        // Explicit serializer rather than the reified `encodeToString(value)`: the
        // reified form needs an extra import, and without it the call silently
        // resolves to the two-argument overload with the arguments in the wrong
        // order. Naming the serializer removes the ambiguity entirely.
        redis.commands.hset(
            key(listing.id),
            mapOf("doc" to json.encodeToString(Listing.serializer(), listing), "version" to "0"),
        ).await()
        redis.commands.sadd(INDEX_KEY, listing.id).await()
    }

    suspend fun find(id: String): Listing? {
        val doc = redis.commands.hget(key(id), "doc").await() ?: return null
        return json.decodeFromString<Listing>(doc)
    }

    suspend fun version(id: String): Long =
        redis.commands.hget(key(id), "version").await()?.toLongOrNull() ?: 0

    /**
     * Compare-and-set update.
     *
     * Returns false when the version moved underneath us, which means another handler
     * changed this listing concurrently and the caller should re-read and re-decide.
     * Surfacing the conflict rather than resolving it here is intentional: only the
     * caller knows whether its event is still meaningful against the newer state.
     */
    suspend fun update(listing: Listing, expectedVersion: Long): Boolean {
        val written = redis.commands.eval<Long>(
            casScript,
            io.lettuce.core.ScriptOutputType.INTEGER,
            arrayOf(key(listing.id), INDEX_KEY),
            json.encodeToString(Listing.serializer(), listing),
            expectedVersion.toString(),
            listing.id,
        ).await()
        return written == 1L
    }

    suspend fun all(): List<Listing> {
        val ids = redis.commands.smembers(INDEX_KEY).await()
        return ids.mapNotNull { find(it) }.sortedByDescending { it.createdAtEpochMs }
    }

    suspend fun byState(predicate: (ListingState) -> Boolean): List<Listing> =
        all().filter { predicate(it.state) }

    private fun key(id: String) = "revendo:listing:$id"

    private companion object {
        const val INDEX_KEY = "revendo:listings"
    }
}
