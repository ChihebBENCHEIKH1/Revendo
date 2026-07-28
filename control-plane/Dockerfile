# Build with the Gradle image so the repo needs no committed wrapper JAR and the
# host needs no JDK — `docker compose up` is the only prerequisite.
FROM gradle:8.10-jdk17 AS build
WORKDIR /home/gradle/project

# Build files first: dependency resolution is the slow step, and it only needs to
# re-run when the build files themselves change.
COPY --chown=gradle:gradle settings.gradle.kts build.gradle.kts ./
RUN gradle --no-daemon dependencies --quiet || true

COPY --chown=gradle:gradle src ./src
# installDist from the `application` plugin produces a start script plus a lib
# directory — no shadow/fat-jar plugin needed, and the layer stays cacheable.
RUN gradle --no-daemon installDist --quiet


FROM eclipse-temurin:17-jre-jammy AS runtime
WORKDIR /app

# Patch the base image before installing anything.
#
# Base tags are rebuilt on a schedule, not on every CVE, so an image pulled today
# routinely carries fixed-but-unapplied vulnerabilities in its OS layer — here that
# was a CRITICAL in libgnutls30 plus several HIGH. `upgrade` costs one layer and is
# the difference between a scanner finding real issues and finding none.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*


# JRE, not JDK: the compiler has no business in a runtime image.
COPY --from=build /home/gradle/project/build/install/revendo-control-plane/ ./

# Container-aware heap sizing. Without MaxRAMPercentage the JVM sizes the heap from
# the host's memory, not the cgroup limit, and gets OOM-killed under a memory cap
# that looked generous.
ENV JAVA_OPTS="-XX:MaxRAMPercentage=70 -XX:+UseContainerSupport -XX:+ExitOnOutOfMemoryError"

RUN useradd --system --uid 10001 revendo
USER revendo

EXPOSE 8081
ENTRYPOINT ["./bin/revendo-control-plane"]
