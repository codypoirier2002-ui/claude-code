# AgentStation

A local command center for a small team of AI agents, shown as a top-down
pixel-art space station. Four OpenClaw agents (Commander, Researcher, Writer,
Reviewer) turn a request into a sourced research report. Every factual claim
is tied to a fetched source, and nothing leaves the machine without your
approval.

![Live dashboard with a finished report](docs/screenshots/live-report.png)

The dashboard shows what the backend reports. It does not make agents reliable
or profitable, and nothing here earns money on its own.

## How it works

```
your laptop                                  your VPS (everything bound to 127.0.0.1)
───────────                                  ────────────────────────────────────────
browser ──ssh tunnel──▶ AgentStation server :8787 ──Bearer token──▶ OpenClaw gateway :18789
                          │  task queue (SQLite)                      │  agents: station-commander,
                          │  approved-source fetcher                  │  -researcher, -writer, -reviewer
                          │  memory/  outputs/  staging/              ▼
                          │  external actions (gated)               claude-cli → your Claude subscription
```

**Workflow:** Request → Plan (Commander) → Fetch (station) → Research
(Researcher) → Draft (Writer) → Review (Reviewer, at most one automatic
revision) → **your approval** → Complete.

**The station does every side effect; agents only return text.** It fetches
from approved domains only, writes files, writes memory, and runs external
actions only after you approve them. The four agents have no working tools:
OpenClaw refuses their shell, file, and web calls, and `npm run probe:tools`
checks it by effect on every agent.

**The queue is explicit code, not a prompt.** It lives in SQLite with two
workers, per-stage timeouts, bounded retries, cancellation, idempotency keys,
compare-and-set state changes, and restart recovery. Task statuses are
`queued`, `running`, `awaiting_approval`, `completed`, `failed`, and
`cancelled`.

**Citations are checked by code.** Each Researcher finding must quote its
source exactly, and the station verifies the quote against the stored text.
The Writer cites `[S#]` IDs only. The station writes the Sources section
itself (URL, retrieval time, SHA-256 of the text the agents read), so URLs
cannot be invented.

**Integration uses only documented OpenClaw surfaces:** `POST /v1/responses`
with `x-openclaw-agent-id`, `GET /readyz`, and the documented CLI commands in
`scripts/setup-openclaw.sh`.

## Install on your VPS

Tested on Ubuntu 24.04. Run every command as the Linux user that will own the
station (a dedicated user is a good idea). Commands marked "laptop" run on your
own computer.

### Quick install (one command)

First harden SSH (key-only login, firewall; see step 1 below). Then create
the user that will own the station. As root on the VPS:

```bash
adduser station
loginctl enable-linger station        # keep its services running after logout
install -d -m 700 -o station -g station ~station/.ssh
install -m 600 -o station -g station ~/.ssh/authorized_keys ~station/.ssh/
```

Log in as that user from your own computer (`ssh station@<your-vps-address>`).
Do not switch with `sudo -iu` or `su`: they give no systemd user session, so
the script cannot install the services and stops. Then:

```bash
git clone https://github.com/codypoirier2002-ui/claude-code.git ~/claude-code
~/claude-code/AgentStation/scripts/install.sh
```

The script runs steps 2 to 5 below in order. You can run it again after a fix
or an update: installs and onboarding that are already done are skipped, while
the tests, the build and the tool probe run every time (add `--skip-probe` once
the probe has passed). It asks before running the
official OpenClaw and Claude Code installers. It stops once for you: Claude
Code's login. Open the URL it prints in a browser on your own computer, sign
in with your Claude account, and paste back the code if the page shows one.

Before it starts the station, it checks:
- Node 24.16+ or 26.1+
- your Claude subscription login
- the agent lockdown (`setup-openclaw.sh`)
- the server tests
- `openclaw security audit` (stops on any critical finding)
- the live tool probe (`probe:tools`; about 80k tokens, skip with `--skip-probe`)

It then installs the station as a systemd user service and confirms that ports
8787 and 18789 listen on localhost only. It never opens a port or prints a
secret. The script itself uses sudo only for `loginctl enable-linger`, and
only if linger is not on yet; the official OpenClaw installer may use sudo to
install Node.js.

When it finishes, open the dashboard as in step 6. The manual steps below are
what the script does, in case you want to run them yourself.

### 1. Prepare the server

Harden SSH access before installing anything (key-only login, firewall). The
OpenClaw docs cover this under "Linux server → Harden admin access first".
Nothing in this setup opens a public port.

### 2. Install OpenClaw (official installer)

```bash
curl -fsSL https://openclaw.ai/install.sh | bash -s -- --no-onboard
openclaw --version            # tested with 2026.9.9; Node 24.16+ or 26.1+ required
```

### 3. Log Claude Code in to your subscription, then onboard OpenClaw

```bash
# Install Claude Code first if needed (see its official setup docs at code.claude.com), then:
claude auth login
claude auth status --text
openclaw onboard --non-interactive --accept-risk \
  --mode local --auth-choice anthropic-cli --secret-input-mode ref \
  --gateway-bind loopback --gateway-auth token \
  --install-daemon --skip-channels --skip-search --skip-skills --skip-hooks --skip-ui
sudo loginctl enable-linger "$USER"     # keep the gateway running after you log out
openclaw gateway status                 # expect: Listening 127.0.0.1:18789
```

### 4. Get AgentStation and configure OpenClaw for it

```bash
git clone https://github.com/codypoirier2002-ui/claude-code.git ~/claude-code
ln -s ~/claude-code/AgentStation ~/AgentStation
cd ~/AgentStation
scripts/setup-openclaw.sh               # creates the 4 agents and locks them down (idempotent)
openclaw gateway restart                # only if the script says so
scripts/init-secrets.sh                 # creates ~/.agentstation/secrets.env (dashboard admin token)
```

`setup-openclaw.sh` does the following, using only documented commands:

- keeps the gateway on loopback with token auth, and backs the token with
  `~/.openclaw/.env` (mode 600) so the station server can read it
- enables `/v1/responses`
- turns off heartbeat and dreaming (background model calls), memory search,
  the browser, and elevated tools
- sets exec policy to `deny-all`, globally and for each agent
- stops agents from reading each other's sessions
- creates `station-commander`, `-researcher`, `-writer`, and `-reviewer` from
  OpenClaw's role templates, installs `agents/<role>/AGENTS.md`, and gives each
  `deny: ["*"]` tools, no skills, and no delegation

> The exec deny applies to the whole gateway, including OpenClaw's default
> `main` agent. If you also use OpenClaw for other things, give AgentStation
> its own gateway or OS user.

### 5. Build, verify, and start

```bash
cd ~/AgentStation/server && npm ci && npm test && npm run probe:tools
cd ~/AgentStation/dashboard && npm ci && npm run build
openclaw security audit --deep          # expect 0 critical; see docs/VERIFICATION.md for the 2 expected warnings
mkdir -p ~/.config/systemd/user
cp ~/AgentStation/deploy/agentstation.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now agentstation
journalctl --user -u agentstation -n 20
```

`probe:tools` makes one real agent call per agent (about 20k tokens each). Run
it again after every OpenClaw or Claude Code update.

### 6. Open the dashboard (laptop)

```bash
~/claude-code/AgentStation/deploy/tunnel.sh you@your-vps
# open http://127.0.0.1:8787 and log in with the token from:
#   ssh you@your-vps 'grep STATION_ADMIN_TOKEN ~/.agentstation/secrets.env | cut -d= -f2'
```

Never expose port 8787 or 18789 publicly. The server also rejects any `Host`
header other than localhost.

## Configuration

| What | Where |
| --- | --- |
| Ports, timeouts, workers (max 2), default limits, approved domains, agent IDs, time zone | `config/station.json` |
| Daily and per-task token caps, dollar limit, team mode (Commander only / full team), approved domains | Dashboard → *Spending, limits & safety*. Stored in SQLite and overrides the file. |
| Generic webhook destinations | `config/station.json` → `actions.webhookAllowlist`. File-only on purpose; restart to apply. Empty means no `webhook_post` can run. |
| Slack webhook | `SLACK_WEBHOOK_URL` in `~/.agentstation/secrets.env` (see [Slack](#integration-slack)). Read when needed; no restart. |
| Role instructions | `agents/<role>/AGENTS.md`; re-run `scripts/setup-openclaw.sh` after editing |
| Agent model | `STATION_MODEL=anthropic/claude-opus-5-5 scripts/setup-openclaw.sh` (default Sonnet 5.5) |
| Goals, rules, decisions, project notes | `memory/` (see `memory/README.md`) |
| Dashboard admin token | `~/.agentstation/secrets.env` (mode 600; the server refuses group- or world-readable files). `STATION_SECRETS_FILE` points elsewhere. |
| Gateway token | `~/.openclaw/.env` (mode 600) |

No secret is ever written to `config/`, `memory/`, logs, SQLite, git, or the
browser. The browser holds only an HttpOnly session cookie and a CSRF token.

### Spending limit

You asked for $5/day. The Claude subscription route reports **tokens, not
dollars**, so the station enforces a **daily token cap** instead and shows
"Cost unavailable" rather than inventing a figure.

The default of 2,000,000 tokens/day is roughly $5/day at Claude Sonnet 5.5 API
rates for this workload. A full team task measured about 145k reported tokens,
about $0.35 at API rates. There is also a 400,000-token per-task cap.

When the daily cap is reached, new agent calls stop and the dashboard says
why. A call already in progress can overshoot by one call.

On this route OpenClaw undercounts **output** tokens (single digits for
multi-page replies). Input tokens, which are about 99% of the total, are
counted in full. Treat the totals as a lower bound.

## Using it

1. **New task:** describe what to research, then pick the approved source
   types: Wikipedia, arXiv, PyPI, GitHub READMEs, or URLs you paste (approved
   domains only). Optionally add a project (loads
   `memory/projects/<name>.md`) or a dependency.
2. **Watch it:** a crew member walks to their workstation only while the
   backend reports their step running.
   - Amber `!`: waiting for you.
   - Red `x`: failed.
   - Green check: just finished.
   - `z`: standby (Commander-only mode).
   - Dimmed scene with **DISCONNECTED**: the link to the station or OpenClaw
     is down, and no agent is shown as working.
3. **Approve:** read the draft, the reviewer's issues, and the station's
   citation checks. Then choose **Approve & save** (writes to `outputs/` and
   updates memory), **Request changes** (with a note), or **Reject**. Tick any
   proposed decisions you want remembered.
4. **External actions:** if a request asks to send or publish something,
   Commander lists it and the station holds it as a separate approval. It runs
   only if you approve it, the report is approved, and its destination is
   allow-listed. It runs once, with an idempotency key, and is never resent
   automatically after a restart.
5. **Pause / cancel / retry:** *Pause* in the top bar stops new steps.
   *Cancel* aborts the running agent call. *Retry* restarts a failed task from
   the step that failed.

## Task type: product listing copy

**New task → Product listing** drafts marketplace listing copy: a title, 3
to 5 bullet points, a description, and tags. You paste it into the
marketplace yourself. The station never publishes a listing.

1. Enter the product, the marketplace (General, Etsy, eBay, or Amazon), and
   the **product facts**: material, size, care, origin, anything true. The
   copy can claim only what these facts, or an approved source, say. Add the
   maker's page under URLs if it is on an approved domain.
2. The team runs the usual workflow:
   - Your facts become source **S1**. The Researcher quotes facts from S1 and
     the station checks every quote against it, so an invented spec never
     reaches the Writer.
   - The Writer cites `[S#]` on every line.
   - The Reviewer flags unsupported claims, superlatives, and invented
     specifics.
   - The station checks the citations and the marketplace's length limits
     itself, and sends the copy back once if it breaks them.
3. Approve it like a report. The saved file in `outputs/` starts with
   **Ready to paste** (citations removed, character counts shown), then
   **Claim support** (each line with its source). **Copy listing text** on
   the task copies the ready-to-paste part.

Limits the station enforces, and where they come from:

| Marketplace | Title | Tags | Source |
| --- | --- | --- | --- |
| eBay | 80 characters | none (no tags field) | [eBay Trading API: listing title](https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/listing-title.html) |
| Amazon | 200 characters | none | [Seller Central: product detail page rules](https://sellercentral.amazon.com/help/hub/reference/external/G202024200) |
| Etsy | 140 characters | 13, each up to 20 characters | Seller guides such as [Outfy](https://www.outfy.com/blog/etsy-character-limit/); Etsy's own help pages were not reachable, so check its form |
| Kijiji | not confirmed, none enforced | none | n/a |
| General | none | up to 15 | n/a |

**Selling in Canada** (the default) adds Canadian rules:
- Canadian spelling.
- Metric units first when your facts give them. The Writer never converts
  units.
- No currency unless your facts name one.
- A "Made in Canada" / "Product of Canada" claim only if your facts say it in
  those words. The station blocks any such claim that isn't in your facts. The
  [Competition Bureau's guidelines](https://competition-bureau.canada.ca/en/node/944)
  set thresholds for those claims: 51% of direct costs plus a note on imported
  content, or 98% for "Product of Canada".

Kijiji is listed, but its title limit could not be confirmed, so none is
enforced. If you sell to customers in Quebec, the Charter of the French
language generally requires French for commercial publications. French copy
is not generated yet.

**Automation (Controls → Listings, both off by default):**
- *Auto-approve clean listings* approves listing copy only when the Reviewer
  passed it and every station check passed: citations, limits, origin claims,
  and no notes in the copy. Flagged listings and all research reports still
  wait for you.
- *Send every approved listing to Slack* posts each approved listing, whether
  approved automatically or by you, to your Slack channel without a separate
  click. It uses the same escaping and webhook binding as manual posts, and an
  unconfirmed send still goes to *Actions to check*.

Every automatic decision is logged in Activity and in the task's history.

Amazon's bullet-point limits vary by category and could not be confirmed, so
none are enforced; check your category template. Marketplace rules beyond
length (banned characters, capitalization) are not checked.

Memory works in plain Markdown and is Obsidian-compatible: open
`AgentStation/memory` as a vault. See `memory/README.md` for exactly what is
read and written, and when.

## Backup and recovery

```bash
scripts/backup.sh                 # → ~/agentstation-backups (mode 600)
scripts/backup.sh --station-only  # skip the OpenClaw archive
```

- **Station archive:** a consistent online copy of the SQLite database (with
  integrity check), plus `memory/`, `outputs/`, `staging/`, `config/`, and a
  SHA-256 file.
- **OpenClaw archive:** `openclaw backup create --verify`. It contains
  OpenClaw credentials, so store it encrypted.
- **Not included:** the two secrets files. Keep them in a password manager, or
  regenerate them (`scripts/init-secrets.sh`; delete the token line in
  `~/.openclaw/.env` and re-run `setup-openclaw.sh`). Both tokens are read at
  start, so after a change restart the gateway and then the station
  (`openclaw gateway restart`, `systemctl --user restart agentstation`). A new
  admin token ends every dashboard session.

To restore:

```bash
systemctl --user stop agentstation
scripts/restore.sh ~/agentstation-backups/agentstation-<stamp>.tar.gz   # keeps data/pre-restore-<stamp>/
systemctl --user start agentstation
# OpenClaw: openclaw backup restore <openclaw-archive> --target <fresh dir>   (stages files; see its docs)
```

Schedule backups with a systemd timer or cron, and copy them off the VPS.

## Demo Mode

```bash
cd server && npm run demo        # http://127.0.0.1:8788
```

Demo Mode uses scripted agents and sources, and makes no network or model
calls. It has its own database, memory copy, outputs folder, and port, and
every screen carries a striped **DEMO MODE** banner. It reports no usage, so
no token totals are invented.

## Implemented

- OpenClaw installed and hardened with documented commands only; four
  isolated agents built from OpenClaw role templates with station-specific
  instructions
- Tool lockdown checked live by effect (`probe:tools`): no Bash or Write
  canary file, no Read content returned, no WebFetch connection
- Memory read at task start and written at completion through fixed code
  paths, with a SHA-256 of the memory each stage saw
- SQLite task state:
  - fields: ID, description, assigned agent, status, created/updated times,
    dependencies, output location, approval requirement, error and detail,
    reported tokens, cost (when reported)
  - steps with attempts, timeouts, OpenClaw response IDs, and usage
- Explicit queue:
  - two workers, timeouts, bounded retries with backoff
  - non-transient errors fail fast
  - cancellation propagates to OpenClaw
  - idempotent task creation, compare-and-set approvals and completions
  - single-instance lock, crash recovery, clean-shutdown requeue
- Approved-source fetcher: https only, exact-host allowlist re-checked on every
  redirect, size and time limits, untrusted-content markers, verified quotes
- Two task types: sourced research reports, and product listing copy
  (drafting only; your facts as source S1; marketplace length checks)
- Approval gates for final reports, clarifications, and external actions
  (Slack posts and generic webhooks; exact text approved before sending,
  idempotency key, `needs_review` when delivery is unconfirmed or a crash
  interrupts a send)
- Daily and per-task token caps enforced from reported usage; explicit
  "cost unavailable" handling
- React + TypeScript + PixiJS dashboard:
  - four connected rooms with original pixel art and state-driven animation
  - task form, queue, agent status, activity history
  - output viewer: report, sources with hashes and exact text, step timeline,
    plan and reviews
  - approvals, pause / cancel / retry, limits, team mode, approved domains
  - live updates over SSE, "Disconnected" handling, phone layout, strict CSP
- Auth: admin token → HttpOnly session, CSRF on every control action,
  loopback `Host` and `Origin` checks, login rate limit
- Demo Mode, backup and restore, systemd unit, SSH tunnel helper
- 52 automated tests; seven live demonstrations (see `docs/VERIFICATION.md`)

## Limitations (read these)

- **No dollar cost on the subscription route.** The limit is a token cap.
  Output tokens are undercounted by OpenClaw on `claude-cli`, so totals are a
  lower bound.
- **About 20k tokens per agent call, minimum.** Claude Code's system prompt
  and the workspace files are sent on every call. A full team report costs
  roughly 100k–150k reported tokens.
- **Sandboxing is policy, not a container.** On the `claude-cli` route Claude
  Code runs on the host. OpenClaw's Docker sandbox does not apply; protection
  comes from OpenClaw's exec deny and PreToolUse hook. Native tool names still
  appear in the model's tool list (calls are refused). Re-run `probe:tools`
  after upgrades.
- **Research is limited to what the station can fetch.** That means
  Wikipedia, arXiv, PyPI metadata, GitHub READMEs (not issues or code), and
  pasted URLs on approved domains. There is no general web search, and
  HTML-to-text for arbitrary pages is basic.
- **Quote checks prove the quote exists, not that the claim is fair.** Reviewer
  and your approval are the safeguard for interpretation.
- **One operator, one admin token**; no roles or multi-user audit trail.
- **Two external action types exist**: `slack_post` (one channel, through
  the webhook you set up) and `webhook_post` (empty allowlist by default).
  Email, publishing, purchasing, deletion, production changes, and account
  connections have no executor, so they are always refused even if approved.
- **The Slack integration was tested against a stand-in, not Slack.** The
  build container could not reach Slack. Your first real post is the live
  test; check the channel and the *Integrations* line under Controls.
- **Two OpenClaw audit warnings remain by design** (`trusted_proxies_missing`,
  device-less `probe_failed`); see `docs/VERIFICATION.md`.
- **Built and verified in a cloud container**, where only PyPI and GitHub
  content were reachable. Wikipedia and arXiv adapters are implemented but
  could not be exercised live there. Check them on your VPS with a small task.
- The scene needs WebGL; without it the panels still work and a notice is
  shown.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Dashboard says Disconnected (OpenClaw) | `openclaw gateway status`, `systemctl --user status openclaw-gateway` |
| `agentstation: no OPENCLAW_GATEWAY_TOKEN` | re-run `scripts/setup-openclaw.sh`, then `openclaw gateway restart` |
| Tasks stay queued | top bar: paused? hold banner (token cap, gateway not ready)? dependency not finished? |
| Fetch fails with HTTP 403 | the host is blocked by your network or by the site; see the error in the task |
| `OpenClaw … 401` | the token in `~/.openclaw/.env` changed: restart the gateway, then the station (`systemctl --user restart agentstation`); both read it only at start |
| An agent should not be able to do X | `npm run probe:tools`, `openclaw exec-policy show --agent station-commander` |

## Integration: Slack

Posts a short summary of an approved report to one Slack channel: the
report's first section, its source list, the review verdict, and where the
full report is saved. Every post waits for your approval of its exact text.

**Set up (once, about five minutes):**

1. Create a Slack app for your workspace at <https://api.slack.com/apps>
   (*Create New App* → *From scratch*). You need permission to install apps.
2. In the app, open *Incoming Webhooks*, turn them on, click *Add New Webhook
   to Workspace*, and pick the channel the station may post to.
3. Copy the webhook URL (`https://hooks.slack.com/services/…`). On the VPS,
   run the script and paste the URL when it asks. The input is hidden, and the
   URL never lands in your shell history:

   ```bash
   ~/claude-code/AgentStation/scripts/set-slack-webhook.sh
   ```

   It checks the URL's form, stores it in `~/.agentstation/secrets.env` (mode
   600), and replaces any earlier one. `--remove` deletes it.

4. Open the dashboard. Under *Spending, limits & safety → Integrations*, Slack
   should say "set up" with the last four characters of the URL. No restart
   is needed.

Slack's guide: [Sending messages using incoming webhooks](https://docs.slack.dev/messaging/sending-messages-using-incoming-webhooks).

**Post a report:** open a completed task and click **Post to Slack…**. The
station writes the message and holds it under *Approvals* with the exact
text. **Approve & post** sends it within a few seconds (if the queue is
paused, it is sent when you resume the queue). You can also ask for
it in the task ("…and share the result in Slack"). The Commander then lists a
`slack_post`, and you can approve it once the report is approved and the
message is written.

**What the station guarantees:**

- Nothing is posted without your approval of that exact text. The text you
  approved is the text sent, and a retry resends the same text.
- The approval is bound to the webhook set when you approved. If you change
  `SLACK_WEBHOOK_URL` before it sends, the post is refused, not redirected.
- Report and source text is escaped the way Slack requires (`&`, `<`, `>`),
  so it cannot form `@channel`/`@here` alerts, user mentions, or hidden
  links. Link previews are off.
- One post per report. A refused post (for example `no_service` after the
  webhook was removed, or `channel_is_archived`) shows Slack's answer and can
  be posted again. A post whose delivery is unconfirmed (timeout, Slack
  server error) is never resent on its own. It appears under *Actions to
  check*: look at the channel, then choose *mark done* or *retry*.
- The URL is a secret. It stays in the secrets file: never in SQLite, logs,
  events, git, or the browser. Demo Mode never posts.

To stop posting, run `scripts/set-slack-webhook.sh --remove`. To revoke the webhook
itself, remove it in the Slack app's *Incoming Webhooks* page.

## Next: one business integration at a time

Slack and the listing-copy task type are in. Add the next one the same way:
for anything that leaves the station, its own executor in
`server/src/actions.ts`, exact-content approval, a destination bound at
approval time, and tests with a stand-in for the service. Publishing a listing
to a marketplace would be such an action, and would also need a marketplace
account connection (which requires your approval).
