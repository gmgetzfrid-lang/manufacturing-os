# Multi-stage: compile with Maven, run on a slim JRE. No local JVM needed —
# the build happens inside Docker, so `docker build` is all you need.

FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
# Warm the dependency cache (best-effort; ignored if offline resolution fails).
RUN mvn -q -e -DskipTests dependency:go-offline || true
COPY src ./src
RUN mvn -q -e -DskipTests clean package

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /app/target/mpp-converter.jar app.jar
# Cloud Run / most hosts inject PORT; default to 8080 locally.
ENV PORT=8080
EXPOSE 8080
CMD ["java", "-jar", "app.jar"]
