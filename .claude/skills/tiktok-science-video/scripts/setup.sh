#!/usr/bin/env bash
# One-time setup for local narration: a Piper TTS venv and an English voice model.
# Everything goes in ~/.cache/tiktok-science (override with TIKTOK_CACHE_DIR). Needs python3, internet.
set -euo pipefail
C="${TIKTOK_CACHE_DIR:-$HOME/.cache/tiktok-science}"
mkdir -p "$C/voices"
[ -x "$C/venv/bin/python" ] || python3 -m venv "$C/venv"
"$C/venv/bin/pip" install -q piper-tts
M=en_US-lessac-medium
B=https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium
for f in "$M.onnx" "$M.onnx.json"; do
  [ -s "$C/voices/$f" ] || curl -fsSL -o "$C/voices/$f" "$B/$f"
done
echo "Narration ready in $C"
