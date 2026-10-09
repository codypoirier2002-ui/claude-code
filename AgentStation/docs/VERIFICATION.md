# Verification record

What was tested, how, and what happened. Run on 2026-10-09 in a Linux cloud
container (Ubuntu 24.04, Node 24.21.0, OpenClaw 2026.9.9, Claude Code 2.1.296)
against the real OpenClaw gateway, using a Claude subscription through
OpenClaw's `claude-cli` route. Models: `anthropic/claude-sonnet-5-5` for all
four agents.

## Backend (Step 2)

| Check | Command | Result |
| --- | --- | --- |
| Gateway running, local-only | `openclaw gateway status` | `Listening: 127.0.0.1:18789`, connectivity probe ok |
| Health | `openclaw gateway health`, `GET /readyz` | `OK`, HTTP 200 |
| Message round trip | `openclaw agent --agent main --message …` | `STATION ONLINE` |
| HTTP integration | `POST /v1/responses` without / with token | 401 / `completed` with usage |
| Doctor | `openclaw doctor --non-interactive` | no errors; warnings reviewed below |
| Security audit | `openclaw security audit --deep` | 0 critical, 2 warn (both reviewed below) |

Reviewed findings:

- `gateway.trusted_proxies_missing`: not applicable. The gateway is bound to
  loopback and no reverse proxy is used.
- `gateway.probe_failed: missing scope: operator.read`: the CLI's deep probe
  connects without a device identity, and the gateway clears scopes for such
  connections by design (docs: gateway/protocol/auth.md). The HTTP API used by
  AgentStation authenticates with the shared token and gets full operator
  scope (docs: gateway/operator-scopes.md, "Shared-secret auth").
- `security.trust_model.cross_agent_session_access_default`: fixed by setting
  `tools.sessions.visibility = "self"` and `tools.agentToAgent.enabled = false`
  (now in `scripts/setup-openclaw.sh`).
- Doctor: "tools.exec is configured under a minimal profile". Intended: each
  station agent carries `tools.exec.mode = "deny"` as a second lock behind the
  gateway-wide deny.
- Doctor: legacy browser relay auth, unused skills, memory search without a
  key, heartbeat: all disabled or turned off (no agent uses them, and heartbeat
  and dreaming would spend tokens outside the station's limits).

## Security finding fixed during setup

With OpenClaw's default host exec policy (`full` / no prompts), a station
agent with `tools.profile = "minimal"` and `tools.deny = ["*"]` still ran Claude
Code's native Bash and Read through the `claude-cli` route (it printed
`/etc/hostname` and `id` output). Fix: `openclaw exec-policy preset deny-all`
plus `tools.exec.mode = "deny"` globally and per agent. After the fix, every
native tool call is refused by OpenClaw's PreToolUse hook
(`OpenClaw exec policy denied native tool use (security=deny, ask=off)`).

`npm run probe:tools` checks this on disk, not by trusting the model: each
agent is told to create two canary files and read a secret file.

```
commander  PASS: shell, write, and read all refused  (21343 tokens)
researcher PASS: shell, write, and read all refused  (19871 tokens)
writer     PASS: shell, write, and read all refused  (21955 tokens)
reviewer   PASS: shell, write, and read all refused  (19903 tokens)
```

A second finding: when the gateway was started from a shell that belonged to
another Claude Code session, the `claude` processes it spawned inherited that
session's environment (plugins, MCP servers, session plumbing). The gateway is
now started with a clean environment; under systemd on a VPS this is the
default. Side effect: the per-call token floor fell from ~43k to ~20k.

## Automated tests

`cd server && npm test`: 18 tests, all passing.

- full workflow (plan → fetch → research → draft → review → approval → complete), output file, memory writes
- duplicate protection (same idempotency key, double approval, single finalize)
- external action gate: no send without approval, exactly one send after, no resend after restart, `needs_review` after a crash mid-send
- destination not on the allowlist is refused even when approved
- timeout with bounded retry, then a useful error; non-transient errors are not retried
- cancellation aborts the in-flight agent call and discards late results
- crash recovery (step requeued, completed stages not rerun); clean shutdown requeues without spending an attempt
- daily token cap blocks new agent calls with a reason; lifting it resumes work
- at most two concurrent agent calls
- task dependencies (wait; fail if the dependency is cancelled)
- clarification round trip
- a staged draft edited after approval is refused at publish time
- retry re-proposes actions voided by the failure but not ones the operator rejected
- memory: role-specific reads, approved writes, agent text cannot inject headings

API checks against the running server: no session → 401; foreign `Host`
header → 421 (DNS-rebinding guard); missing CSRF → 403; foreign `Origin` →
403; sixth wrong login in a minute → 429; strict CSP and anti-framing headers
present; neither secret appears in any API response.

## The seven required demonstrations

| # | Demonstration | What happened |
| --- | --- | --- |
| 1 | Real task through the complete workflow | T-0002 and T-0003 ran Commander → Researcher → Writer → Reviewer, with one revision each. T-0002's first review passed but the station's own check found two uncited paragraphs and forced a revision; the second draft had none. T-0003 was created and approved through the dashboard UI. |
| 2 | Output with traceable sources | Every report ends with a Sources section listing URL, retrieval time, and SHA-256 of the text the agents read. An independent Python check recomputed every hash from the database (all match, all present in the reports) and confirmed 24/24 Researcher quotes appear verbatim in the cited source. Sample: `docs/sample-output/`. |
| 3 | Approval gate prevents an external action | T-0004's request said "post the brief to our team webhook". Commander proposed it; the station held it. After the report was approved and the task completed, the local test receiver had **0** requests. After the operator approved the action (and its URL was added to the allowlist), the receiver got exactly **1** request with an idempotency key. Two restarts later: still 1. A second approval was refused. |
| 4 | Failed task with a useful error | T-0005 (Wikipedia only) failed at fetch: `en.wikipedia.org: HTTP 403 (refused: blocked by the network policy or by the site)`, not retried ("this error will not go away on its own"), logged to the daily note. 21k tokens spent (the plan only). |
| 5 | Restart preserves state | Station stopped mid-research on T-0003 and restarted: the step was requeued (no attempt spent) and the task finished. Station restarted twice during the T-0004 gate demo: the pending approval, the completed task, and the delivered action all survived, and nothing was resent. A backup → delete database and reports → restore cycle brought back all 7 tasks and reports. |
| 6 | Disconnected backend shown as disconnected | OpenClaw gateway stopped with the dashboard open: banner "Disconnected: the OpenClaw gateway is unreachable" after 4.8s, all four agents OFFLINE, scene dimmed. A task queued during the outage made zero agent calls (hold reason shown) and was cancelled. Reconnected 1.7s after the gateway came back. Station server stopped: "Disconnected" within 0.2s, controls disabled; reconnected in 2.2s. |
| 7 | Usage limit blocks new work | Daily cap lowered to 100,000 in the dashboard (usage was 477,297): hold banner "Daily token cap reached"; a new task stayed queued with 0 attempts and 0 tokens. Restoring the cap cleared the hold. |

Screenshots: `docs/screenshots/`.

## Bugs found by these demonstrations and fixed

- A clean shutdown (SIGTERM) marked the running step failed instead of
  requeuing it. Fixed and covered by a test.
- Retrying a task whose failure had voided a proposed external action did not
  bring the action back. Fixed and covered by a test.
- Identical fetch errors were repeated once per query; now grouped.
- The usage meter and cap input shared an accessible name; renamed.

## Usage on the test day

20 agent calls, 477,297 reported tokens (cache reads 212,200; cache writes
264,966). Reported output tokens: 91 for 81,253 characters of agent output.
The `claude-cli` route undercounts output tokens, so these totals are a lower
bound. No dollar cost is available on this route.

| Task | Mode | Agent calls | Reported tokens |
| --- | --- | --- | --- |
| T-0001 | Commander only | 3 | 72,400 |
| T-0002 | full team, 1 revision | 6 | 145,073 |
| T-0003 | full team, 1 revision, 1 interrupted call | 7 | 143,494 |
| T-0004 | Commander only, 1 retried call | 3 | 95,263 |
| T-0005 | failed at fetch | 1 | 21,067 |
