#!/usr/bin/env bash
# Back up AgentStation and (by default) OpenClaw.
#
#   scripts/backup.sh                 # station archive + `openclaw backup create --verify`
#   scripts/backup.sh --station-only  # skip the OpenClaw archive
#
# Writes to $BACKUP_DIR (default ~/agentstation-backups), files mode 600:
#   agentstation-<UTC stamp>.tar.gz         SQLite (online copy), memory/, outputs/, staging/, config/
#   agentstation-<UTC stamp>.tar.gz.sha256  checksum
#   openclaw-backup-*.tar.gz                OpenClaw's own archive (config, sessions, workspaces,
#                                           AND CREDENTIALS, per its docs): store it encrypted.
#
# Not included on purpose: ~/.agentstation/secrets.env and ~/.openclaw/.env.
# Keep those in your password manager; they are easy to regenerate (see README).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${BACKUP_DIR:-$HOME/agentstation-backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$DEST"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

node --disable-warning=ExperimentalWarning "$ROOT/server/scripts/backup-db.ts" "$WORK/station.sqlite"
mkdir -p "$WORK/tree"
cp -a "$ROOT/memory" "$ROOT/outputs" "$ROOT/staging" "$ROOT/config" "$WORK/tree/"
mv "$WORK/station.sqlite" "$WORK/tree/station.sqlite"
ARCHIVE="$DEST/agentstation-$STAMP.tar.gz"
tar -C "$WORK/tree" -czf "$ARCHIVE" .
(cd "$DEST" && sha256sum "$(basename "$ARCHIVE")" > "$(basename "$ARCHIVE").sha256")
echo "station archive: $ARCHIVE"

if [ "${1:-}" != "--station-only" ]; then
  if command -v openclaw >/dev/null; then
    openclaw backup create --output "$DEST" --verify
  else
    echo "openclaw not on PATH; skipped the OpenClaw archive" >&2
  fi
fi
