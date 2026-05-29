# Multi-stage: build the fat-jar with Maven, run with a minimal JRE.

FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
# Cache the Maven dependency layer first.
COPY pom.xml .
RUN mvn -B -e -q dependency:go-offline
COPY src ./src
RUN mvn -B -e package -DskipTests

FROM eclipse-temurin:17-jre-jammy
WORKDIR /app
COPY --from=build /app/target/mpxj-converter.jar /app/mpxj-converter.jar
ENV PORT=8080
EXPOSE 8080
# Liveness — GET / returns 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- --tries=1 http://localhost:${PORT}/ >/dev/null || exit 1
ENTRYPOINT ["java", "-XX:+UseContainerSupport", "-jar", "/app/mpxj-converter.jar"]
