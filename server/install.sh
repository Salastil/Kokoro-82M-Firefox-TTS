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

if ! command -v espeak-ng >/dev/null 2>&1; then
  echo "warning: espeak-ng not found on PATH. kokoro's phonemizer may need it"
  echo "  for out-of-dictionary words. If synthesis errors mention espeak,"
  echo "  install it: apt install espeak-ng | pacman -S espeak-ng | dnf install espeak-ng"
  echo
fi

# kokoro (the TTS package) currently requires Python >=3.10,<3.13.
# Rolling-release distros like Arch often ship only a newer default
# python3 in their official repos with no simple package for an older
# minor version, so this doesn't just take whatever "python3" resolves
# to -- it looks for a version actually in range first.
find_compatible_python() {
  for candidate in python3.12 python3.11 python3.10; do
    if command -v "$candidate" >/dev/null 2>&1; then
      echo "$candidate"
      return 0
    fi
  done
  if command -v python3 >/dev/null 2>&1; then
    local minor
    minor="$(python3 -c 'import sys; print(sys.version_info[1])' 2>/dev/null || echo 0)"
    if [ "$minor" -ge 10 ] && [ "$minor" -le 12 ]; then
      echo "python3"
      return 0
    fi
  fi
  return 1
}

echo "==> Looking for a compatible Python (3.10-3.12; kokoro doesn't support 3.13+ yet)"
USED_UV=false
if PYTHON_BIN="$(find_compatible_python)"; then
  echo "    Using $PYTHON_BIN ($("$PYTHON_BIN" --version))"
  echo "==> Creating virtualenv at $VENV_DIR"
  "$PYTHON_BIN" -m venv "$VENV_DIR"
elif command -v uv >/dev/null 2>&1; then
  echo "    No system Python in range, but uv is installed -- letting it fetch"
  echo "    an isolated Python 3.12 (doesn't touch your system Python at all)."
  echo "==> Creating virtualenv at $VENV_DIR"
  uv venv --python 3.12 "$VENV_DIR"
  USED_UV=true
else
  cat >&2 <<'EOF'
error: no Python 3.10-3.12 found, and `uv` isn't installed to fetch one.

kokoro (the TTS package this server uses) currently requires Python
>=3.10,<3.13. On rolling-release distros like Arch, the official repos
usually only ship the latest Python, with no easy package for an older
minor version.

Easiest fix -- install uv, which can provision an isolated Python 3.12
without touching your system Python at all, then re-run this script:
  curl -LsSf https://astral.sh/uv/install.sh | sh

Alternatives: pyenv (https://github.com/pyenv/pyenv), or an AUR package
like python312 if you're on Arch.
EOF
  exit 1
fi

PIP="$VENV_DIR/bin/pip"
if [ "$USED_UV" = true ]; then
  # uv-created venvs don't ship pip by default; bootstrap one so the
  # rest of this script (and the README's manual-run instructions) can
  # keep using plain `pip install` uniformly either way.
  uv pip install --python "$VENV_DIR/bin/python" --upgrade pip >/dev/null
else
  "$PIP" install --upgrade pip >/dev/null
fi

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

# misaki (kokoro's English text-processing dependency) auto-downloads
# this spaCy model the first time it's actually used if it's missing.
# Pre-installing it now avoids that happening (with a multi-second
# stall, and a chance of failing to be picked up by the process that
# triggered it) during someone's first real synthesis request instead.
echo "==> Installing the spaCy English model kokoro's phonemizer needs"
"$VENV_DIR/bin/python" -m spacy download en_core_web_sm

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
