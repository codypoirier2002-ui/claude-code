# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

This repository is the owner's fork of `anthropics/claude-code`, the public
repository and not the CLI source. It keeps the upstream parts and adds the
owner's own projects. There is no root `package.json` or workspace: each
subproject installs and runs on its own.

- `AgentStation/`: a self-hosted dashboard that runs a team of four OpenClaw
  agents (see "AgentStation architecture" below).
- `claude-api-quickstart/`: one Messages API call with `@anthropic-ai/sdk`
  (`quickstart.ts`, model `claude-opus-5-5`, reads `ANTHROPIC_API_KEY`).
- `mods/`: four hooks-module plugins (`sec-default`, `diff`, `telemetry`,
  `agents-md`). Each has `.claude-plugin/plugin.json`, `hooks/` and `tests/`.
  Shared types are in `mods/types/claude-code.d.ts`.
- `games/`: `rule-flip/index.html` is a single-file browser game.
  `ue5-open-world/` holds `BUILD_PLAN.md` and Unreal Editor Python scripts
  (`scripts/p1`–`p9`). There is no `.uproject`, and the scripts have not run in
  a real editor.
- `.claude/`: repository commands (`commit-push-pr`, `dedupe`, `triage-issue`),
  the `tiktok-trend-scout` agent and the `tiktok-science-video` skill. The skill
  needs ffmpeg and Python 3, and its `scripts/setup.sh` installs Piper TTS. The
  agent file also exists at `.claude/skills/tiktok-science-video/agents/`;
  keep the two copies identical.
- From upstream: `plugins/` (listed in `.claude-plugin/marketplace.json`),
  `examples/` (gateway, settings, MDM and hooks samples), `scripts/` (Bun
  TypeScript issue automation run by the issue workflows, and the `gh.sh`
  wrapper `/dedupe` uses), `Script/` (Windows devcontainer launcher),
  `CHANGELOG.md`, and `README.md`, which documents installing Claude Code.

## Security hardening for GitHub Actions

Workflow jobs in this repository that call Claude run with three protections.
Keep them when you add or edit a workflow.

1. **Egress-firewall runner.** The job has `runs-on: ubuntu-24.04-firewall`,
   a GitHub-hosted runner that filters the job's outbound network traffic. Do
   not move a job that calls Claude to another runner.
2. **Network allow list.** `.github/egress-firewall.yaml` lists the hosts
   those jobs may reach, besides any that GitHub's firewall allows by default.
   Keep `mode: enforce`, which is what makes the firewall block the rest. Follow
   that file's header when you add a host.
3. **Auto permission mode.** Every step that runs the Claude Code action
   (`uses: anthropics/claude-code-action`, or a local action with a
   `claude_args` input) passes `--permission-mode auto` in `claude_args`. A tool
   call that needs permission and that the allowed tools do not cover then runs
   only if Claude Code's safety review passes it. Allow only the tools the job
   needs, and keep any `--disallowedTools` list a step has. Use `claude-opus-4-6`
   or a newer model: on an older one Claude Code falls back to its default
   permission mode.

`claude.yml` answers `@claude` mentions. The Claude Code action sets
`--permission-mode acceptEdits` for those, and the `--permission-mode auto` in
the workflow's `claude_args`, which comes after it, replaces it.

`.github/workflows/workflow-hardening.yml` fails when a job that runs the Claude
Code action or mentions `ANTHROPIC_FEDERATION_RULE_ID` breaks protection 1 or 3,
or when the allow list is missing, empty, not `mode: enforce`, or names a host
with `*`. It cannot see a job that calls Claude another way, so check new
workflows by hand too. If a job cannot meet protection 1 or 3, add it with the
reason to the matching exemption table in
`.github/scripts/check_workflow_hardening.py`. A job in `EXEMPT_FROM_AUTO_MODE`
must set no permission mode at all. Do not skip or weaken the check.

Keep each workflow's `permissions:` block minimal, and never print tokens or
environment variables in workflow logs.

## Branches and pull requests

Every change reaches `main` through a reviewed pull request.

- Do not commit or push to `main` directly. Start each change on its own branch
  from the latest `main`:
  `git fetch origin main && git checkout -b claude/<short-topic> origin/main`.
  Keep one topic per branch.
- Before pushing, run the checks for the code you changed:
  - `AgentStation/server`: `npm test` and `npm run typecheck`
  - `AgentStation/dashboard`: `npm run build` (it type-checks first)
  - `claude-api-quickstart`: `npm run typecheck`
- Open a pull request against `main`. Keep it small: one feature or one fix.
  The description says what changed, why, and how you checked it.
- CodeRabbit reviews every pull request. Fix each finding, or reply on its
  thread saying why not, before asking for the merge.
- The repository owner merges. Do not merge your own pull request unless the
  owner asks for that in the conversation.
- After a merge, start the next change on a new branch from the updated
  `main`. Do not add new work to a branch whose pull request has merged.

## Commands

`node_modules` is not committed: run `npm ci` in a subproject before its
other commands. CI does not build or test `AgentStation/` or
`claude-api-quickstart/`, so the local checks above are the only ones.

`AgentStation/server` needs Node `>=24.16 <25` or `>=26.1` (it uses
`node:sqlite`). Node runs the `.ts` files directly, so there is no build step.

```bash
npm test             # every test/**/*.test.ts, with node:test
npm run typecheck
npm run demo         # demo mode on 127.0.0.1:8788; prints a one-run login token unless STATION_ADMIN_TOKEN is set
npm start            # real mode on 8787; needs the admin and OpenClaw gateway tokens
npm run probe:tools  # checks that the OpenClaw agents have no tools; costs about 20k tokens per agent
```

To run one test file or one test (`npm test -- <file>` does not narrow the
run, because the glob is in the script):

```bash
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/engine.test.ts
node --disable-warning=ExperimentalWarning --test --test-concurrency=1 --test-name-pattern="<title substring>" test/engine.test.ts
```

`AgentStation/dashboard` has no tests. `npm run dev` starts Vite on 5173 and
proxies `/api` to `127.0.0.1:8787`. `npm run build` type-checks and writes
`dist/`, which the server serves; the server answers 503 until it exists.

`claude-api-quickstart`: `npm run typecheck`, and `node quickstart.ts "question"`
to run it.

`mods/` (checked by `.github/workflows/mod-tests.yml`):

```bash
tsc -p mods/tsconfig.json
claude plugin test mods/<mod>/
```

Workflow hardening check, from the repository root (Python 3.10+, with PyYAML
or `yq`):

```bash
python3 .github/scripts/check_workflow_hardening.py
```

## AgentStation architecture

- **The station does not run models.** `server/src/main.ts` starts the server
  from `http.ts`, which is plain `node:http` with server-sent events at
  `GET /api/stream`: no WebSocket, no child processes. The plan, research,
  draft and review steps each POST `/v1/responses` to the OpenClaw gateway on
  `127.0.0.1:18789` (`openclaw.ts`), naming the agent in `x-openclaw-agent-id`
  (`station-commander`, `-researcher`, `-writer`, `-reviewer`, configured in
  `config/station.json`). OpenClaw runs those agents through the Claude Code
  CLI.
- **Pipeline.** `engine.ts` runs two workers through the stages plan, fetch,
  research, draft, review, approval and finalize. Fetch and finalize run in the
  station itself. The agents have no tools (`scripts/setup-openclaw.sh` sets
  their exec policy to deny-all) and see only what the station sends them.
  Each role's instructions are in `agents/<role>/AGENTS.md`. The commander only
  lists external actions such as Slack posts or webhooks; the station runs each
  one after a person approves it in the dashboard. The exception is the opt-in
  setting "Send every approved listing to Slack" (off by default), which
  approves those Slack posts without a click.
- **State.** `db.ts` uses `node:sqlite` in WAL mode at `data/station.sqlite`
  (demo: `data/demo/demo.sqlite`), with tables for tasks, steps, sources,
  approvals, actions, usage, events, settings and sessions. `data/station.lock`
  keeps a second instance from starting. Token caps default to 2,000,000 a day
  and 400,000 a task (`config/station.json`); changes made in the dashboard are
  stored in the `settings` table.
- **Security model.** The server accepts only a loopback `Host`. Logging in
  with the admin token sets an HttpOnly, SameSite=Strict `station_session`
  cookie and a per-session CSRF token. Every non-GET request except
  `POST /api/login` needs the `x-station-csrf` header. An `Origin` header, when
  sent, must be on the allowed list. Bodies are capped at 64 KiB. Never expose 8787 or 18789 beyond loopback.
- **Configuration.** Only `config.ts` reads the environment: `STATION_ROOT`,
  `STATION_MODE`, `STATION_DATA_DIR`, `STATION_PORT`, `STATION_SECRETS_FILE`
  (default `~/.agentstation/secrets.env`), `STATION_ADMIN_TOKEN` and
  `OPENCLAW_GATEWAY_TOKEN` (falls back to `~/.openclaw/.env`). The Slack
  webhook URL comes only from the secrets file.
- **Dashboard.** React 19 and PixiJS 8. `dashboard/src/api.ts` calls the same
  origin with the CSRF header and listens on an `EventSource` for
  `/api/stream`.
- **Deployment.** `scripts/install.sh` sets up an Ubuntu VPS as a non-root
  user: it installs OpenClaw and Claude Code, runs the server tests and the
  dashboard build, and installs `deploy/agentstation.service` as a systemd user
  unit. Real mode is meant for that VPS only.
- **Artifact port.** `claude-artifact/agentstation.html` is a separate,
  single-file version for claude.ai Artifacts built on the `window.claude`
  runtime. It shares no code with the server or dashboard. `SPEC.md` describes
  the server behaviour it copies, and `PORT-NOTES.md` lists what is still
  unverified. A change to server behaviour may need the same change there.

## Gotchas

- Node runs the TypeScript in `AgentStation/server` and
  `claude-api-quickstart` through type stripping: no enums, namespaces or
  parameter properties, and local imports keep their `.ts` extension. The
  server's `tsconfig.json` enforces this with `erasableSyntaxOnly`; the
  quickstart's does not, so `tsc` will not catch it there.
- On Windows, use demo mode: real mode needs the OpenClaw gateway and is meant
  for the VPS. `AgentStation/scripts/install.sh` needs Linux (`systemctl`,
  `loginctl`, `ss`); the other scripts there need bash. The lock test needs
  `/proc`, so it is skipped on Windows.
- `npm run demo` sets `STATION_MODE=demo` with POSIX syntax. In PowerShell,
  run `$env:STATION_MODE='demo'; npm start` instead.
- The dashboard's Vite proxy always targets port 8787, so it does not reach a
  demo server on 8788 unless you edit `dashboard/vite.config.ts`.
- `.devcontainer/` uses Node 20, which cannot run AgentStation or the
  quickstart.
