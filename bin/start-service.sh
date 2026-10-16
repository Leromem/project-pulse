#!/bin/sh
# Starts the Project Pulse service in the background, detached from this terminal (macOS, Linux).
# Running it twice is safe: the second copy sees the first one answering and exits.
#   sh start-service.sh [--open] [--project <id>]
app=$(cd "$(dirname "$0")/.." && pwd)
node=node
if [ -f "$app/bin/node.txt" ]; then
  node=$(head -n 1 "$app/bin/node.txt" | tr -d '\r')
fi
if command -v setsid >/dev/null 2>&1; then
  setsid "$node" "$app/service/server.mjs" "$@" </dev/null >/dev/null 2>&1 &
else
  nohup "$node" "$app/service/server.mjs" "$@" </dev/null >/dev/null 2>&1 &
fi
