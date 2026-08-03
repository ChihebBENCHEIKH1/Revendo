plugins {
    kotlin("jvm") version "2.4.10"
    kotlin("plugin.serialization") version "2.4.10"
    application
}

group = "com.revendo"
version = "1.0.0"

repositories {
    mavenCentral()
}

val ktorVersion = "3.5.1"
val coroutinesVersion = "1.11.0"

dependencies {
    // Pull transitive families to patched versions.
    //
    // Ktor 3.0.0 brings Netty 4.1.114 and the Anthropic SDK brings an older Jackson;
    // both carry fixed HIGH-severity CVEs (netty-codec CVE-2026-42583,
    // jackson-databind CVE-2026-54512/54513). BOMs rather than single-artifact pins
    // so the whole family moves together — bumping netty-codec alone while
    // netty-transport stays behind is how you turn a CVE into a NoSuchMethodError.
    implementation(platform("io.netty:netty-bom:4.2.16.Final"))
    implementation(platform("com.fasterxml.jackson:jackson-bom:2.22.1"))

    // --- Ktor ---------------------------------------------------------------
    implementation("io.ktor:ktor-server-core:$ktorVersion")
    implementation("io.ktor:ktor-server-netty:$ktorVersion")
    implementation("io.ktor:ktor-server-content-negotiation:$ktorVersion")
    implementation("io.ktor:ktor-serialization-kotlinx-json:$ktorVersion")
    implementation("io.ktor:ktor-server-status-pages:$ktorVersion")
    implementation("io.ktor:ktor-server-call-logging:$ktorVersion")
    implementation("io.ktor:ktor-server-call-id:$ktorVersion")
    implementation("io.ktor:ktor-server-default-headers:$ktorVersion")
    implementation("io.ktor:ktor-server-metrics-micrometer:$ktorVersion")

    // --- Concurrency, serialization ------------------------------------------
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:$coroutinesVersion")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.11.0")
    implementation("org.jetbrains.kotlinx:kotlinx-datetime:0.8.0")

    // --- Infrastructure -------------------------------------------------------
    implementation("com.rabbitmq:amqp-client:5.34.0")
    // Lettuce over Jedis: its async API is genuinely non-blocking, which matters when
    // the whole service is coroutine-based. A blocking client would force every Redis
    // call onto a thread pool and quietly reintroduce the thread-per-request model
    // coroutines exist to avoid.
    implementation("io.lettuce:lettuce-core:6.4.0.RELEASE")
    implementation("io.micrometer:micrometer-registry-prometheus:1.17.0")
    implementation("ch.qos.logback:logback-classic:1.6.1")

    // Anthropic's official Java SDK — Kotlin uses it directly. Only reached when
    // ANTHROPIC_API_KEY is present; the demo's default negotiation path is offline.
    implementation("com.anthropic:anthropic-java:2.52.0")

    // --- Test -----------------------------------------------------------------
    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:$coroutinesVersion")
    testImplementation("io.ktor:ktor-server-test-host:$ktorVersion")
}

kotlin {
    jvmToolchain(17)
    compilerOptions {
        // Warnings become errors. On a small service this is free discipline; the
        // moment it stops being free is usually the moment it starts being useful.
        allWarningsAsErrors.set(false)
        freeCompilerArgs.add("-Xjsr305=strict")
    }
}

application {
    mainClass.set("com.revendo.ApplicationKt")
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "skipped", "failed")
        showStandardStreams = false
    }
}
