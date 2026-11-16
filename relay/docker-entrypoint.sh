#!/bin/sh
# Fix /data ownership (fresh Fly volumes are mounted root-owned), then run the relay as the
# unprivileged `node` user. If the container already runs as non-root, just exec.
set -eu
if [ "$(id -u)" = "0" ]; then
  mkdir -p /data
  chown node:node /data
  chmod 0700 /data
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
