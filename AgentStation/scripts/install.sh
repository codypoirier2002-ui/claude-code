#!/usr/bin/env bash
# One-command AgentStation install for an Ubuntu VPS. Runs README steps 2-5
# in order and stops only where you have to act (logging Claude Code in to
# your subscription). Safe to re-run: installs and onboarding that are already
# done are skipped; the tests, the build and the tool probe run every time
# (add --skip-probe once the probe has passed).
#
# Run it as the Linux user that will own the station (not root), logged in
# over SSH or with `machinectl shell` so it has a systemd user session:
#   git clone https://github.com/codypoirier2002-ui/claude-code.git ~/claude-code
#   ~/claude-code/AgentStation/scripts/install.sh
#
#   --skip-probe   skip the live tool-lockdown check (it makes one agent call
#                  per agent, about 80k tokens in total)
#   --yes          do not ask before running the official OpenClaw and Claude
#                  Code installers
#
# It never opens a port or prints a secret. The script itself uses sudo only
# for `loginctl enable-linger` (so the services survive logout); the official
# OpenClaw installer may use sudo to install Node.js.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
USER="${USER:-$(id -un)}"   # unset under some su/cron setups
PROBE=1
ASSUME_YES=0
for arg in "$@"; do
  case "$arg" in
    --skip-probe) PROBE=0 ;;
    --yes) ASSUME_YES=1 ;;
    -h|--help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

STEP="start"
step() { STEP="$1"; printf '\n== %s\n' "$1"; }
ok() { printf '   ok: %s\n' "$1"; }
warn() { printf '   WARNING: %s\n' "$1"; }
die() { printf '\nSTOPPED at "%s": %s\n' "$STEP" "$1" >&2; exit 1; }
trap 'printf "\nSTOPPED at \"%s\" (a command above failed). Fix it and run this script again.\n" "$STEP" >&2' ERR

confirm() {
  [ "$ASSUME_YES" = 1 ] && return 0
  [ -t 0 ] || die "$1 needs your confirmation, but there is no terminal. Re-run with --yes, or run the script directly instead of piping it."
  read -r -p "   $1 [y/N] " reply
  [[ "$reply" =~ ^[Yy] ]]
}

# The official installers put their tools on a login shell's PATH (and Claude
# Code at ~/.local/bin), not necessarily on this shell's.
refresh_path() {
  local login_path
  login_path="$(bash -lc 'printf %s "$PATH"' 2>/dev/null || true)"
  export PATH="$HOME/.local/bin:${login_path:+$login_path:}$PATH"
  hash -r
}

version_at_least() { # version_at_least 24.21.0 24.16.0
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -n1)" = "$2" ]
}

wait_for() { # wait_for <seconds> <command...>
  local limit="$1"; shift
  for _ in $(seq 1 "$limit"); do "$@" && return 0; sleep 1; done
  return 1
}

# ---------------------------------------------------------------------------
step "Preflight"
# `sudo -iu <user>` / `su` give no systemd user session, so the services could
# not be installed; the user has to really log in.
NEW_USER_HELP="As root (or with sudo):
  adduser station
  loginctl enable-linger station
  install -d -m 700 -o station -g station ~station/.ssh
  install -m 600 -o station -g station ~/.ssh/authorized_keys ~station/.ssh/
Then log in as that user from your computer (ssh station@<your-vps-address>),
clone the repo, and run this script. Do not use 'sudo -iu' or 'su': they give
no systemd user session."
[ "$(id -u)" != 0 ] || die "run this as the non-root user that will own the station, not as root.
$NEW_USER_HELP"
# shellcheck source=/dev/null
os_name="$( . /etc/os-release 2>/dev/null && printf '%s|%s' "${ID:-}" "${PRETTY_NAME:-unknown}" || true)"
[ "${os_name%%|*}" = ubuntu ] || warn "tested on Ubuntu 24.04; this is ${os_name#*|}."

missing=()
for tool in curl git openssl ss sort; do command -v "$tool" >/dev/null || missing+=("$tool"); done
[ ${#missing[@]} = 0 ] || die "missing tools: ${missing[*]}. Install them with: sudo apt-get update && sudo apt-get install -y curl git openssl iproute2 coreutils"
# A user manager can be running (linger) while this shell lacks its address.
uid="$(id -u)"
if [ -z "${XDG_RUNTIME_DIR:-}" ] && [ -S "/run/user/$uid/bus" ]; then
  export XDG_RUNTIME_DIR="/run/user/$uid"
  export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
fi
systemctl --user show-environment >/dev/null 2>&1 \
  || die "no systemd user session in this shell, so the gateway and the station cannot be installed as services.
$NEW_USER_HELP"
# Without linger the services stop when you log out.
if [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)" != yes ]; then
  if sudo -n true 2>/dev/null || id -nG | grep -qwE 'sudo|admin|wheel'; then
    echo "   Keeping your services running after you log out needs sudo once:"
    sudo loginctl enable-linger "$USER"
  else
    die "linger is off for $USER and this user cannot use sudo. Ask an admin to run: sudo loginctl enable-linger $USER, then re-run."
  fi
fi
ok "systemd user session; services keep running after logout (linger on)"
# The service unit runs %h/AgentStation, so ~/AgentStation must be this copy.
if [ -L "$HOME/AgentStation" ] || [ -e "$HOME/AgentStation" ]; then
  [ "$(cd "$HOME/AgentStation" && pwd -P)" = "$(cd "$ROOT" && pwd -P)" ] \
    || die "$HOME/AgentStation already exists and is not this copy ($ROOT). Move it aside, then re-run."
else
  ln -s "$ROOT" "$HOME/AgentStation"
fi
ok "user $USER, station at $HOME/AgentStation"
refresh_path

# ---------------------------------------------------------------------------
step "OpenClaw (the agent backend)"
if ! command -v openclaw >/dev/null; then
  confirm "Install OpenClaw with its official installer (curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard)? It may use sudo to install Node.js." \
    || die "OpenClaw is required. Install it yourself (README step 2), then re-run."
  curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
  refresh_path
  command -v openclaw >/dev/null || die "the OpenClaw installer finished but openclaw is not on PATH. Open a new shell and re-run."
fi
oc_version="$(openclaw --version | head -n1)"
ok "$oc_version"
[[ "$oc_version" == *2026.9.9* ]] || warn "AgentStation was tested with OpenClaw 2026.9.9; re-run with the tool check (no --skip-probe) to confirm the lockdown still holds."
command -v node >/dev/null || die "node is not on PATH; the OpenClaw installer normally sets it up. Open a new shell and re-run."
node_version="$(node --version | sed 's/^v//')"
if ! { version_at_least "$node_version" 24.16.0 && ! version_at_least "$node_version" 25.0.0; } && ! version_at_least "$node_version" 26.1.0; then
  die "Node $node_version is too old or unsupported; AgentStation needs Node 24.16+ (24.x) or 26.1+."
fi
ok "Node $node_version"

# ---------------------------------------------------------------------------
step "Claude Code, logged in to your Claude subscription"
if ! command -v claude >/dev/null; then
  confirm "Install Claude Code with its official installer (curl -fsSL https://claude.ai/install.sh | bash)?" \
    || die "Claude Code is required. Install it yourself (code.claude.com/docs/en/setup), then re-run."
  curl -fsSL https://claude.ai/install.sh | bash
  refresh_path
  command -v claude >/dev/null || die "the Claude Code installer finished but claude is not on PATH (expected ~/.local/bin/claude)."
fi
ok "$(claude --version | head -n1)"
if ! claude auth status >/dev/null 2>&1; then
  [ -t 0 ] || die "Claude Code is not logged in and there is no terminal to log in from. Run: claude auth login, then re-run this script."
  echo "   Claude Code is not logged in. Next:"
  echo "     1. A URL appears below. Open it in a browser on your own computer and sign in with your Claude account."
  echo "     2. If the page shows a code, paste it here at the 'Paste code here' prompt."
  claude auth login
  claude auth status >/dev/null 2>&1 || die "Claude Code is still not logged in. Run: claude auth login, then re-run."
fi
auth_method="$(claude auth status 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).authMethod??"")}catch{console.log("")}})')"
case "$auth_method" in
  claude.ai|oauth_token) ok "logged in with your Claude subscription ($auth_method)" ;;
  "") ok "logged in" ;;
  *) warn "logged in with '$auth_method', not a Claude subscription login; agent calls may be billed per token to that account." ;;
esac

# ---------------------------------------------------------------------------
step "OpenClaw gateway: local-only, token auth"
if [ -f "$HOME/.openclaw/openclaw.json" ]; then
  ok "already onboarded ($HOME/.openclaw/openclaw.json)"
else
  openclaw onboard --non-interactive --accept-risk \
    --mode local --auth-choice anthropic-cli --secret-input-mode ref \
    --gateway-bind loopback --gateway-auth token \
    --install-daemon --skip-channels --skip-search --skip-skills --skip-hooks --skip-ui
fi

# ---------------------------------------------------------------------------
step "AgentStation agents and lockdown (scripts/setup-openclaw.sh)"
setup_out="$("$ROOT/scripts/setup-openclaw.sh" 2>&1)" || { printf '%s\n' "$setup_out"; die "setup-openclaw.sh failed (output above)."; }
printf '%s\n' "$setup_out" | sed -n '/^== /p;/created/p'
# Restart on every run, so the gateway always holds the token the station uses
# (a run that stopped inside setup-openclaw.sh would otherwise leave them apart).
openclaw gateway restart
gateway_ready() { curl -fsS --noproxy 127.0.0.1 --max-time 3 http://127.0.0.1:18789/readyz 2>/dev/null | grep -q '"ready":true'; }
wait_for 120 gateway_ready || die "the OpenClaw gateway is not ready on 127.0.0.1:18789. Check: openclaw gateway status
If an earlier run stopped during onboarding, the gateway service may not be installed: run the onboard command from README step 3 (it is safe to repeat), then re-run this script."
ok "gateway ready on 127.0.0.1:18789"

step "Dashboard admin token (scripts/init-secrets.sh)"
"$ROOT/scripts/init-secrets.sh" | sed -n '1p'

# ---------------------------------------------------------------------------
step "Build and test"
(cd "$ROOT/server" && npm ci --no-audit --no-fund --loglevel=error)
test_log="$(mktemp)"
(cd "$ROOT/server" && npm test >"$test_log" 2>&1) || { tail -n 40 "$test_log"; rm -f "$test_log"; die "server tests failed (last lines above)."; }
# Pass/fail comes from the exit code above; the counts are for show (format varies by Node version).
grep -E '^(# |ℹ )(pass|fail) ' "$test_log" | sed -E 's/^(# |ℹ )/   tests /' || true
rm -f "$test_log"
(cd "$ROOT/dashboard" && npm ci --no-audit --no-fund --loglevel=error && npm run build --silent >/dev/null)
ok "server tests pass; dashboard built"

step "Security checks"
critical="$(openclaw security audit --deep --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).summary.critical)}catch{console.log("?")}})')"
[ "$critical" = 0 ] || die "openclaw security audit reports critical findings ($critical). Run: openclaw security audit --deep"
ok "openclaw security audit: 0 critical (2 warnings are expected; see docs/VERIFICATION.md)"
if [ "$PROBE" = 1 ]; then
  echo "   Live check that agents cannot use Bash, Write, Read, or WebFetch (about 80k tokens)..."
  (cd "$ROOT/server" && npm run --silent probe:tools) || die "the tool probe failed. Do not start the station until it passes; its output above says why (a tool an agent must not have, or an agent call that failed)."
else
  warn "skipped the live tool check (--skip-probe). Run it later: cd $ROOT/server && npm run probe:tools"
fi

# ---------------------------------------------------------------------------
step "Start the station"
station_up() { curl -fsS --noproxy 127.0.0.1 --max-time 3 http://127.0.0.1:8787/api/health 2>/dev/null | grep -q '"ok":true'; }
service_up() { systemctl --user is-active --quiet agentstation && station_up; }
# A station started by hand holds the lock and the port; the service would
# crash-loop behind it while the health check answered from the old copy.
if station_up && ! systemctl --user is-active --quiet agentstation; then
  die "a station that is not the service is already running on 127.0.0.1:8787. Stop it (Ctrl-C where you ran npm start), then re-run with --skip-probe."
fi
mkdir -p "$HOME/.config/systemd/user"
install -m 644 "$ROOT/deploy/agentstation.service" "$HOME/.config/systemd/user/agentstation.service"
systemctl --user daemon-reload
systemctl --user enable agentstation >/dev/null 2>&1
systemctl --user restart agentstation
{ wait_for 30 service_up && sleep 3 && service_up; } \
  || { journalctl --user -u agentstation -n 30 --no-pager || true; die "the station did not start (log above)."; }
ok "running as a service: systemctl --user status agentstation"

step "Exposure check"
exposed="$(ss -ltnH 2>/dev/null | awk '{print $4}' | grep -E ':(8787|18789)$' | grep -vE '^(127\.0\.0\.1|\[::1\]):' || true)"
[ -z "$exposed" ] || die "these listeners are reachable from outside: $exposed. Stop the station and the gateway and fix gateway.bind / config/station.json, then re-run with --skip-probe."
ok "the dashboard (8787) and gateway (18789) listen on localhost only"

# ---------------------------------------------------------------------------
cat <<EOF

AgentStation is installed.

Open the dashboard from your own computer (the VPS port stays private):
  ssh -N -L 8787:127.0.0.1:8787 $USER@<your-vps-address>
  then browse to http://127.0.0.1:8787

Log in with the admin token. Show it on the VPS (keep it private):
  grep STATION_ADMIN_TOKEN ~/.agentstation/secrets.env | cut -d= -f2

Optional:
  Slack copies of approved listings:  $ROOT/scripts/set-slack-webhook.sh
  Logs:                               journalctl --user -u agentstation -f
EOF
