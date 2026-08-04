#!/usr/bin/env bash
# Installs npm dependencies and a systemd --user service that runs the
# companion server continuously (started now, and on every login;
# see the loginctl note this script prints at the end for boot-time
# start without needing to log in first).
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="kokoro-reader-server.service"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "error: node not found on PATH. Install Node.js 20+ first." >&2
  exit 1
fi

NODE_MAJOR="$(node -e 'process.stdout.write(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "error: Node.js 20+ required, found $(node --version)." >&2
  exit 1
fi

echo "==> Installing npm dependencies in $SERVER_DIR"
(cd "$SERVER_DIR" && npm install --omit=dev)

echo "==> Writing systemd user unit to $UNIT_DIR/$UNIT_NAME"
mkdir -p "$UNIT_DIR"
sed \
  -e "s#{{NODE_BIN}}#$NODE_BIN#g" \
  -e "s#{{SERVER_DIR}}#$SERVER_DIR#g" \
  "$SERVER_DIR/systemd/kokoro-reader-server.service.template" > "$UNIT_DIR/$UNIT_NAME"

echo "==> Reloading systemd user units and starting the service"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT_NAME"

echo
echo "Service installed and running."
echo
echo "To also start it at boot without logging in first, run:"
echo "  loginctl enable-linger $USER"
echo
echo "Useful commands:"
echo "  systemctl --user status $UNIT_NAME"
echo "  journalctl --user -u $UNIT_NAME -f"
echo "  systemctl --user restart $UNIT_NAME   # after editing config.json"
echo

sleep 2
echo "==> Current status (also check the log above/via journalctl for the auth token on first run):"
systemctl --user status "$UNIT_NAME" --no-pager || true
