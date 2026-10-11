#!/usr/bin/env bash
# Stores your Slack incoming webhook URL in ~/.agentstation/secrets.env
# (mode 600) without showing it on screen or putting it in shell history.
# The station reads it on its next use; no restart is needed.
#   scripts/set-slack-webhook.sh          paste the URL when asked
#   scripts/set-slack-webhook.sh --remove stop posting to Slack
set -euo pipefail
file="${STATION_SECRETS_FILE:-$HOME/.agentstation/secrets.env}"
umask 077
mkdir -p "$(dirname "$file")"
touch "$file"
chmod 600 "$file"

# Rewrites the file without any SLACK_WEBHOOK_URL line, keeping everything else.
strip() {
  local tmp
  tmp="$(mktemp "$(dirname "$file")/.secrets.XXXXXX")"
  grep -v '^SLACK_WEBHOOK_URL=' "$file" > "$tmp" || true
  chmod 600 "$tmp"
  mv "$tmp" "$file"
}

if [ "${1:-}" = "--remove" ]; then
  strip
  echo "Slack webhook removed from $file. The station stops posting to Slack."
  exit 0
fi

printf 'Paste the Slack webhook URL (input is hidden), then press Enter: '
read -rs url
echo
url="$(printf '%s' "$url" | tr -d '[:space:]')"
# The form the station accepts: https://hooks.slack.com/services/<workspace>/<integration>/<secret>
if ! printf '%s' "$url" | grep -Eq '^https://hooks\.slack\.com/services/[A-Za-z0-9]+/[A-Za-z0-9]+/[A-Za-z0-9]+$'; then
  echo "That is not a Slack incoming webhook URL (https://hooks.slack.com/services/...). Nothing was changed." >&2
  exit 1
fi
strip
# Start on a new line even if the file was saved without a final newline.
[ -s "$file" ] && [ -n "$(tail -c1 "$file")" ] && echo >> "$file"
printf 'SLACK_WEBHOOK_URL=%s\n' "$url" >> "$file"
echo "Saved to $file (ends in ...${url: -4}). Open the dashboard: Controls -> Integrations should say Slack is set up."
