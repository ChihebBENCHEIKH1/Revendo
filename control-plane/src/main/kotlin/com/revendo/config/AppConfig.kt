package com.revendo.config

/**
 * Configuration, read once at boot and validated on the spot.
 *
 * A container that is going to be misconfigured should die immediately with a
 * message naming the variable, not surface it twenty minutes later as a connection
 * refused in an unrelated stack trace.
 */
data class AppConfig(
    val port: Int,
    val redisUrl: String,
    val rabbitUrl: String,
    val marketplaceCapacity: Long,
    val marketplaceRefillPerSecond: Double,
    val maxPublishAttempts: Int,
    val anthropicModel: String,
) {
    companion object {
        fun fromEnvironment(): AppConfig {
            val errors = mutableListOf<String>()

            fun int(name: String, default: Int): Int {
                val raw = System.getenv(name) ?: return default
                return raw.toIntOrNull() ?: run { errors += "$name must be an integer, got '$raw'"; default }
            }

            fun long(name: String, default: Long): Long {
                val raw = System.getenv(name) ?: return default
                return raw.toLongOrNull() ?: run { errors += "$name must be an integer, got '$raw'"; default }
            }

            fun double(name: String, default: Double): Double {
                val raw = System.getenv(name) ?: return default
                return raw.toDoubleOrNull() ?: run { errors += "$name must be a number, got '$raw'"; default }
            }

            val config = AppConfig(
                port = int("PORT", 8081),
                redisUrl = System.getenv("REDIS_URL") ?: "redis://redis:6379",
                rabbitUrl = System.getenv("RABBITMQ_URL") ?: "amqp://guest:guest@rabbitmq:5672",
                marketplaceCapacity = long("MARKETPLACE_RATE_CAPACITY", 20),
                marketplaceRefillPerSecond = double("MARKETPLACE_RATE_REFILL_PER_SECOND", 0.4),
                maxPublishAttempts = int("MAX_PUBLISH_ATTEMPTS", 3),
                anthropicModel = System.getenv("ANTHROPIC_MODEL") ?: "claude-opus-5",
            )

            require(errors.isEmpty()) { "Invalid configuration:\n" + errors.joinToString("\n") { "  - $it" } }
            return config
        }
    }
}
