#!/usr/bin/env bash
# Configures an installed, onboarded OpenClaw for AgentStation. Idempotent:
# safe to re-run after editing agents/*/AGENTS.md or upgrading OpenClaw.
# Uses only documented commands: openclaw config set, exec-policy preset,
# agents add/list. Run it as the user that runs the gateway.
#
#   scripts/setup-openclaw.sh                 # all four agents
#   scripts/setup-openclaw.sh commander       # just one
#   STATION_MODEL=anthropic/claude-opus-5-5 scripts/setup-openclaw.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${STATION_MODEL:-anthropic/claude-sonnet-5-5}"
ROLES=("${@:-commander researcher writer reviewer}")
read -r -a ROLES <<< "${ROLES[*]}"
command -v openclaw >/dev/null || { echo "openclaw not on PATH" >&2; exit 1; }

template_for() { case "$1" in commander) echo coordinator ;; *) echo "$1" ;; esac; }
display_for() { case "$1" in commander) echo Commander ;; researcher) echo Researcher ;; writer) echo Writer ;; reviewer) echo Reviewer ;; esac; }

echo "== Gateway: local-only, token auth, Responses endpoint, no background model calls"
openclaw config set --batch-json '[
  {"path":"gateway.bind","value":"loopback"},
  {"path":"gateway.auth.mode","value":"token"},
  {"path":"gateway.http.endpoints.responses.enabled","value":true},
  {"path":"agents.defaults.heartbeat.every","value":"0m"},
  {"path":"plugins.entries.memory-core.config.dreaming.enabled","value":false},
  {"path":"memory.search.enabled","value":false},
  {"path":"tools.elevated.enabled","value":false},
  {"path":"browser.enabled","value":false},
  {"path":"browser.extensionRelay.allowLegacyAuth","value":false},
  {"path":"tools.exec.mode","value":"deny"}
]'

echo "== Exec approvals: deny-all preset (blocks Claude Code's native Bash/Read/Write/WebFetch under claude-cli)"
openclaw exec-policy preset deny-all >/dev/null

existing="$(openclaw agents list --json)"
for role in "${ROLES[@]}"; do
  id="station-$role"
  ws="$HOME/.openclaw/workspace-$id"
  name="$(display_for "$role")"
  [ -n "$name" ] || { echo "unknown role: $role" >&2; exit 1; }
  echo "== Agent $id ($name)"
  if ! grep -q "\"id\": \"$id\"" <<< "$existing"; then
    openclaw agents add "$id" --role "$(template_for "$role")" --workspace "$ws" --model "$MODEL" --non-interactive --json >/dev/null
    echo "   created"
  fi
  install -m 600 "$ROOT/agents/$role/AGENTS.md" "$ws/AGENTS.md"
  printf '# Identity\n\n- **Name:** %s\n- **Role:** AgentStation %s (no tools)\n' "$name" "$role" > "$ws/IDENTITY.md"
  chmod 600 "$ws/IDENTITY.md"
  # Optional template files that would only add prompt tokens.
  rm -f "$ws/USER.md" "$ws/BOOTSTRAP.md" "$ws/HEARTBEAT.md"
  openclaw config set --batch-json "[
    {\"path\":\"agents.entries.$id.model\",\"value\":\"$MODEL\"},
    {\"path\":\"agents.entries.$id.identity.name\",\"value\":\"$name\"},
    {\"path\":\"agents.entries.$id.tools\",\"value\":{\"profile\":\"minimal\",\"deny\":[\"*\"],\"exec\":{\"mode\":\"deny\"}}},
    {\"path\":\"agents.entries.$id.skills\",\"value\":[]},
    {\"path\":\"agents.entries.$id.subagents\",\"value\":{\"allowAgents\":[]}}
  ]" >/dev/null
  echo "   instructions installed; tools denied; exec denied; no skills; no delegation"
done

echo
echo "Done. Verify with:"
echo "  openclaw exec-policy show --agent station-commander"
echo "  openclaw security audit --deep"
echo "  (cd $ROOT/server && npm run probe:tools)   # live check that native tools are refused"
