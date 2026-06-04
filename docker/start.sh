#!/bin/sh
# Launch the in-container MPXJ converter, then the Next.js app.
#
# The converter is what gives binary .mpp true 1:1 fidelity. It listens on
# loopback only (MPXJ_INTERNAL_PORT); the app reaches it via MPP_CONVERTER_URL.
# If it fails to start, the app still runs — .mpp imports degrade to the
# in-process reader with a clear message rather than 500ing.
set -eu

MPXJ_PORT="${MPXJ_INTERNAL_PORT:-8090}"

echo "[start] launching MPXJ converter on 127.0.0.1:${MPXJ_PORT}"
# Headless AWT so MPXJ's Gantt-view parsing doesn't require a display.
PORT="${MPXJ_PORT}" java -XX:+UseContainerSupport -Djava.awt.headless=true \
  -jar /opt/mpxj/mpxj-converter.jar &

# Hand off to Next.js in the foreground on the platform's $PORT. tini (PID 1)
# forwards signals here and reaps the JVM on shutdown.
echo "[start] launching Next.js on :${PORT:-3000}"
exec npm run start
