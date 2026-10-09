#!/usr/bin/env bash
# Restore an AgentStation archive made by scripts/backup.sh.
#   scripts/restore.sh ~/agentstation-backups/agentstation-<stamp>.tar.gz
#
# Stop the station first (systemctl --user stop agentstation). The current
# state is copied to data/pre-restore-<stamp>/ before anything is replaced,
# so a restore can itself be undone.
#
# OpenClaw state is restored separately with its own documented command:
#   openclaw backup restore <openclaw-archive> --target <fresh dir>
# (it stages files only; see https://docs.openclaw.ai/install/backups).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="${1:?usage: restore.sh <agentstation-archive.tar.gz>}"
LOCK="$ROOT/data/station.lock"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK")" 2>/dev/null; then
  echo "the station is running (pid $(cat "$LOCK")); stop it first" >&2
  exit 1
fi
if [ -f "$ARCHIVE.sha256" ]; then
  (cd "$(dirname "$ARCHIVE")" && sha256sum -c "$(basename "$ARCHIVE").sha256")
else
  echo "warning: no checksum file next to the archive; continuing" >&2
fi
umask 077
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
SAFE="$ROOT/data/pre-restore-$STAMP"
mkdir -p "$SAFE"
[ -f "$ROOT/data/station.sqlite" ] && cp -a "$ROOT"/data/station.sqlite* "$SAFE/" 2>/dev/null || true
cp -a "$ROOT/memory" "$ROOT/outputs" "$ROOT/staging" "$ROOT/config" "$SAFE/"
echo "current state saved to $SAFE"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
tar -C "$WORK" -xzf "$ARCHIVE"
[ -f "$WORK/station.sqlite" ] || { echo "archive has no station.sqlite" >&2; exit 1; }
rm -f "$ROOT"/data/station.sqlite "$ROOT"/data/station.sqlite-wal "$ROOT"/data/station.sqlite-shm
mkdir -p "$ROOT/data"
cp "$WORK/station.sqlite" "$ROOT/data/station.sqlite"
for d in memory outputs staging config; do
  rm -rf "${ROOT:?}/$d"
  cp -a "$WORK/$d" "$ROOT/$d"
done
echo "restored. Start the station; steps that were mid-run when the backup was taken are requeued automatically."
