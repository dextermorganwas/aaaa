#!/bin/sh
set -e

# Runs as root (the image's default user) purely so it can fix ownership of the bind-mounted
# ./data volume, whose ownership on the host is whatever created the folder (usually root) and
# has nothing to do with the user this app actually runs as. PUID/PGID let you match your host
# user if you care about the files in ./data being owned by you outside the container too -
# defaults (1000:1000) match the first regular user on most Linux distros. gosu accepts raw
# numeric uid:gid directly, so there's no need to create a matching named user first.

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p /data/cache /data/db
  chown -R "$PUID:$PGID" /data
  exec gosu "$PUID:$PGID" node server.js
fi

# Already running as a non-root user (e.g. someone set "user:" in compose directly) - just go.
exec node server.js
