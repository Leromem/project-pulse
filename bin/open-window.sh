#!/bin/sh
# Opens the Project Pulse window, starting the service first when needed (macOS, Linux).
exec sh "$(dirname "$0")/start-service.sh" --open "$@"
