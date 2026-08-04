#!/usr/bin/env bash
# Stops and removes the systemd --user service. Leaves config.json
# (with your token) and any downloaded model cache untouched -- delete
# ~/.config/kokoro-reader-server and server/.venv yourself if you want
# a full clean removal.
set -euo pipefail

UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="kokoro-reader-server.service"

if systemctl --user is-active --quiet "$UNIT_NAME" 2>/dev/null; then
  systemctl --user stop "$UNIT_NAME"
fi
systemctl --user disable "$UNIT_NAME" 2>/dev/null || true
rm -f "$UNIT_DIR/$UNIT_NAME"
systemctl --user daemon-reload

echo "Service stopped and unit removed."
echo "Config/token left at: ${XDG_CONFIG_HOME:-$HOME/.config}/kokoro-reader-server/config.json"
