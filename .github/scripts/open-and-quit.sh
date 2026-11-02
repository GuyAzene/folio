#!/bin/bash
# Opens the packaged Folio built for others on an empty home and asks it to quit, which it must do
# on its own. That build has the inspector off, so the real-window checks cannot drive it.
set -euo pipefail
home=$(mktemp -d) connection=$(mktemp -d)
FOLIO_HOME="$home" FOLIO_CONNECTION_HOME="$connection" \
  release/mac-arm64/Folio.app/Contents/MacOS/Folio >/dev/null 2>&1 &
pid=$!
sleep 10
kill -0 "$pid"
kill -TERM "$pid"
for _ in $(seq 1 60); do kill -0 "$pid" 2>/dev/null || exit 0; sleep 0.5; done
echo "Folio did not quit within 30 seconds" && exit 1
