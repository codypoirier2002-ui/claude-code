#!/usr/bin/env bash
# Run this on YOUR computer (not the VPS) to reach the dashboard privately.
# Both the dashboard (8787) and the OpenClaw gateway (18789) stay bound to
# 127.0.0.1 on the VPS; nothing is exposed publicly.
#   deploy/tunnel.sh you@your-vps            -> open http://127.0.0.1:8787
#   deploy/tunnel.sh you@your-vps --with-openclaw   also forwards OpenClaw's own UI to 18789
set -euo pipefail
HOST="${1:?usage: tunnel.sh user@vps [--with-openclaw]}"
# ExitOnForwardFailure: fail loudly if local port 8787 is already taken.
ARGS=(-N -o ExitOnForwardFailure=yes -L 8787:127.0.0.1:8787)
[ "${2:-}" = "--with-openclaw" ] && ARGS+=(-L 18789:127.0.0.1:18789)
echo "Dashboard: http://127.0.0.1:8787  (Ctrl+C closes the tunnel)"
exec ssh "${ARGS[@]}" "$HOST"
