#!/bin/sh
# Render mounts the data disk as root. Give it to the node user, then run the server as that user.
set -e
DATA_DIR="${DATA_DIR:-/tmp/codecity}"
mkdir -p "$DATA_DIR"
chown -R node:node "$DATA_DIR"
if command -v setpriv >/dev/null 2>&1; then
  exec setpriv --reuid=node --regid=node --init-groups node /app/service/server.mjs
fi
echo "setpriv is missing: running as root" >&2
exec node /app/service/server.mjs
