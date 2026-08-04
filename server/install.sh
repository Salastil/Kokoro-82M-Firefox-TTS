#!/usr/bin/env bash
# Creates a venv, installs a torch build matched to your GPU (or CPU
# if none detected), installs the rest of the dependencies, and
# installs + starts a systemd --user service that keeps the server
# running (see the loginctl note this script prints at the end for
# boot-time start without needing to log in first).
set -euo pipefail

SERVER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="$SERVER_DIR/.venv"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_NAME="kokoro-reader-server.service"

PYTHON_BIN="$(command -v python3 || true)"
if [ -z "$PYTHON_BIN" ]; then
  echo "error: python3 not found on PATH. Install Python 3.10+ first." >&2
  exit 1
fi

PY_MINOR="$("$PYTHON_BIN" -c 'import sys; print(sys.version_info[1])')"
if [ "$PY_MINOR" -lt 10 ]; then
  echo "error: Python 3.10+ required, found $("$PYTHON_BIN" --version)." >&2
  exit 1
fi

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "warning: espeak-ng not found on PATH. kokoro's phonemizer may need it"
  echo "  for out-of-dictionary words. If synthesis errors mention espeak,"
  echo "  install it: apt install espeak-ng | pacman -S espeak-ng | dnf install espeak-ng"
  echo
fi

echo "==> Creating virtualenv at $VENV_DIR"
"$PYTHON_BIN" -m venv "$VENV_DIR"
PIP="$VENV_DIR/bin/pip"
"$PIP" install --upgrade pip >/dev/null

echo "==> Detecting GPU for the torch build to install"
if command -v rocminfo >/dev/null 2>&1 || [ -d /opt/rocm ]; then
  echo "    ROCm detected -- installing ROCm-enabled torch."
  echo "    (If this version doesn't match your installed ROCm, see"
  echo "    https://pytorch.org/get-started/locally/ and re-run pip install"
  echo "    torch --index-url ... --force-reinstall with the right tag.)"
  "$PIP" install torch --index-url https://download.pytorch.org/whl/rocm6.2
elif command -v nvidia-smi >/dev/null 2>&1; then
  echo "    NVIDIA GPU detected -- installing CUDA-enabled torch."
  "$PIP" install torch --index-url https://download.pytorch.org/whl/cu121
else
  echo "    No GPU detected -- installing CPU-only torch."
  "$PIP" install torch --index-url https://download.pytorch.org/whl/cpu
fi

echo "==> Installing remaining Python dependencies"
"$PIP" install -r "$SERVER_DIR/requirements.txt"

echo "==> Writing systemd user unit to $UNIT_DIR/$UNIT_NAME"
mkdir -p "$UNIT_DIR"
sed \
  -e "s#{{VENV_DIR}}#$VENV_DIR#g" \
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
