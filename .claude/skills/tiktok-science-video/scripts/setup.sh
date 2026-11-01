#!/usr/bin/env bash
# One-time setup for local narration: a Piper TTS venv and an English voice model.
# Everything goes in ~/.cache/tiktok-science (override with TIKTOK_CACHE_DIR). Needs python3, internet.
# The package version, the model revision, and the model file hashes are pinned so a changed
# upstream cannot silently swap what build.js loads. To upgrade, change the pins here on purpose.
set -euo pipefail
C="${TIKTOK_CACHE_DIR:-$HOME/.cache/tiktok-science}"
mkdir -p "$C/voices"
[ -x "$C/venv/bin/python" ] || python3 -m venv "$C/venv"
"$C/venv/bin/pip" install -q "piper-tts==1.8.0"

M=en_US-lessac-medium
# rhasspy/piper-voices at commit b4e358ffcb232591bf73a540e70f7de528e4174a (immutable ref, not a branch).
B=https://huggingface.co/rhasspy/piper-voices/resolve/b4e358ffcb232591bf73a540e70f7de528e4174a/en/en_US/lessac/medium
declare -A SHA=(
  ["$M.onnx"]=5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f
  ["$M.onnx.json"]=efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0
)
for f in "$M.onnx" "$M.onnx.json"; do
  [ -s "$C/voices/$f" ] || curl -fsSL -o "$C/voices/$f" "$B/$f"
  # Verify even a preexisting file, so a tampered or half-written download never gets used.
  if ! echo "${SHA[$f]}  $C/voices/$f" | sha256sum -c --quiet -; then
    rm -f "$C/voices/$f"
    echo "Checksum mismatch for $f; deleted it. Re-run setup.sh, and if it fails again the pinned model has changed upstream." >&2
    exit 1
  fi
done
echo "Narration ready in $C"
