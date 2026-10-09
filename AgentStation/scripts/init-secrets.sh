#!/usr/bin/env bash
# Creates ~/.agentstation/secrets.env (mode 600) with a random dashboard admin
# token. Never prints the token; read it yourself when you log in:
#   grep STATION_ADMIN_TOKEN ~/.agentstation/secrets.env
set -euo pipefail
dir="${HOME}/.agentstation"
file="${STATION_SECRETS_FILE:-$dir/secrets.env}"
umask 077
mkdir -p "$(dirname "$file")"
touch "$file"
chmod 600 "$file"
if grep -q '^STATION_ADMIN_TOKEN=' "$file"; then
  echo "admin token already set in $file (unchanged)"
else
  echo "STATION_ADMIN_TOKEN=$(openssl rand -hex 24)" >> "$file"
  echo "created admin token in $file"
fi
echo "log in with:  grep STATION_ADMIN_TOKEN $file | cut -d= -f2"
