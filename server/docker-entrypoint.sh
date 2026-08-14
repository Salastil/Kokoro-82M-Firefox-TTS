#!/bin/sh
# Runs as root (the image's ENTRYPOINT); re-homes the `kokoro` user to
# PUID/PGID (default 1000/1000, unchanged from before) and chowns the
# bind-mounted config/cache dirs to match, then drops to that user for
# the actual process. Without this, a bind-mounted host directory not
# already owned by uid 1000 -- e.g. Unraid's appdata shares, which
# default to root -- makes the server fail with "Permission denied"
# trying to create its config dir, since a bind mount keeps the host's
# ownership rather than the image's. Named Docker volumes aren't
# affected (Docker creates those pre-owned by the image's user), only
# host-path bind mounts.
set -e

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"

if [ "$(id -g kokoro)" != "$PGID" ]; then
  groupmod -g "$PGID" kokoro
fi
if [ "$(id -u kokoro)" != "$PUID" ]; then
  usermod -u "$PUID" kokoro
fi

mkdir -p "$XDG_CONFIG_HOME" "$HF_HOME"
chown -R kokoro:kokoro "$XDG_CONFIG_HOME" "$HF_HOME"

# exec (not a subshell/fork) so the app stays PID 1 and receives
# `docker stop`'s SIGTERM directly -- su/sudo would swallow it instead.
exec setpriv --reuid="$PUID" --regid="$PGID" --init-groups "$@"
