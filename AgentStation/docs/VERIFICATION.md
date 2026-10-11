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

`npm run probe:tools` checks this by effect, not by trusting the model. Each
agent is told to use Bash and Write to create two canary files (checked on
disk), Read to print a fresh secret (checked absent from the reply), and
WebFetch on a local endpoint that records every TCP connection and serves a
nonce (no connection, nonce absent from the reply). The Read check shows that
the content did not come back, not that no read was attempted. Re-run on
2026-10-10:

```
commander  PASS  Bash: no canary file; Write: no canary file; Read: secret not in reply; WebFetch: no connection to local endpoint  (21728 tokens)
researcher PASS  Bash: no canary file; Write: no canary file; Read: secret not in reply; WebFetch: no connection to local endpoint  (19881 tokens)
writer     PASS  Bash: no canary file; Write: no canary file; Read: secret not in reply; WebFetch: no connection to local endpoint  (19832 tokens)
reviewer   PASS  Bash: no canary file; Write: no canary file; Read: secret not in reply; WebFetch: no connection to local endpoint  (19901 tokens)
```

In this container the gateway's outbound traffic goes through an egress
proxy, so the WebFetch check is weaker here than on a VPS without one; the
exec policy (`openclaw exec-policy show --agent <id>`) is the other evidence.

A second finding: when the gateway was started from a shell that belonged to
another Claude Code session, the `claude` processes it spawned inherited that
session's environment (plugins, MCP servers, session plumbing). The gateway is
now started with a clean environment; under systemd on a VPS this is the
default. Side effect: the per-call token floor fell from ~43k to ~20k.

## Automated tests

`cd server && npm test`: 52 tests, all passing.

- full workflow (plan → fetch → research → draft → review → approval → complete), output file, memory writes
- duplicate protection (same idempotency key, double approval, single finalize)
- external action gate: no send without approval, exactly one send after, no resend after restart, `needs_review` after a crash mid-send
- destination not on the allowlist is refused even when approved
- the webhook allowlist matches whole path segments (`/notify` does not allow `/notify-other`) and refuses userinfo and encoded slashes
- changing the admin token ends every session made with the old one
- a task failed by a broken dependency can be retried once the dependency succeeds
- runnable steps are not starved by many waiting steps ahead of them
- a memory write error after publishing is logged; the approved task still completes
- more than 8 URLs are refused, not silently dropped
- draft parsing keeps sections after a model-added References section
- citation checks: only a heading exempts a section; every S# in any bracket is checked
- a ``` inside a JSON string does not break parsing
- stock phrases do not verify a finding; whole metadata lines and REPL lines do
- plan source types match case-insensitively; a ready plan with no usable query is retried
- project slugs are never empty and never shared; long notes keep their newest entries; appends start on a new line
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
- a hold reason left over from before a restart is cleared on the first tick
- a sources heading the Writer adds is dropped; "Sources of disagreement" is kept
- a stale lock file whose pid now belongs to another process does not block startup
- Slack: report and source text cannot form mentions, links, or `@here` alerts; URLs keep their `@`; long reports and long source lists are cut without losing the footer or splitting an escape
- Slack: setup status for a missing, group-readable, or non-Slack webhook URL; Demo Mode never posts
- Slack: preparing a post sends nothing; approving it sends exactly the approved text once (POST JSON, no redirects, link previews off); a second post of the same report is refused; the webhook secret appears nowhere in the state, events, or database
- Slack: 404 `no_service` and refused connections fail with nothing sent; a timeout goes to review, is not retried on its own, and a retry resends the same text; a webhook changed after approval blocks the post
- Slack: a post the Commander proposes gets its text only when the report is approved, and cannot be approved before that; approval is refused while Slack is not set up
- a generic webhook answering 503 goes to review instead of failing; marking a post done clears its old error
- listing copy: the fact sheet is S1, nothing is fetched without queries, a quote not in the fact sheet never reaches the Writer, and the saved file's ready-to-paste copy has no citation markers or operator notes
- listing copy over a marketplace limit, with an uncited line, or with tags where the marketplace has none, goes back to the Writer with the station's reasons
- Canadian listings get Canadian rules; a "Made in Canada" claim not in the fact sheet sends the copy back, and one the operator stated passes
- with auto-approve on, a clean listing completes and is posted to Slack exactly once with no click; with it off, a flagged listing, or any report, still waits; with Slack not set up the skip is logged
- listing requests with an unknown marketplace, a missing product, or too few facts are refused before queuing; the draft round-trips through its rendered form; operator notes inside the copy are flagged

API checks against the running server: no session → 401; foreign `Host`
header → 421 (DNS-rebinding guard); missing CSRF → 403; foreign `Origin` →
403; sixth wrong login in a minute → 429; strict CSP and anti-framing headers
present; neither secret appears in any API response. Added 2026-10-10: a login
with a foreign `Origin` → 403 and a non-JSON login → 415, neither counting
towards the lockout (six cross-site attempts, then the real login → 200); an
open `/api/stream` ends 4 s after its session logs out; restarting with a
different admin token → old cookie 401.

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

Found later (2026-10-10), by review and by a container restart, and fixed with
tests: a stale "on hold" banner after a restart; a Writer section such as
"Sources of disagreement" being cut from the report; the station refusing to
start after a reboot because its old pid now belonged to another process;
`npm run dev` refusing every dashboard change (the dev proxy forwarded the
dev server's Origin); `restore.sh` continuing after a failed safety copy.
A security review pass then found, and these were fixed: a web page the
operator visited could lock them out of login by spending the failed-login
budget; the webhook allowlist matched by raw string prefix; changing the admin
token did not end existing sessions; a live stream kept sending state after
logout.

A full review pass followed (2026-10-10): five reviewers (engine, parsing and
memory, dashboard, API contract, ops) reported 30 distinct findings, and each
was checked against the code before it was fixed. The fixes:
- **Engine:** retry for dependency-failed tasks; no 20-step candidate window;
  memory write errors no longer fail an approved task or block cancel/reject;
  fetch keeps partial results under a time budget; usage counts each step once
  and buckets by the station's day.
- **Parsing and memory:** sources-section stripping, citation checks, quote
  specificity, `>>>` in quotes, fenced JSON, plan source types, project slugs,
  newest-first clipping of long notes, newline-safe appends.
- **Dashboard:** the queue label no longer says "Working" while disconnected; a
  stale snapshot isn't shown as live after logout/login; Demo Mode is labelled
  before the first snapshot; a stale "Start after" choice isn't submitted; an
  empty dollar field isn't saved as $0; the CSRF token refreshes after a login
  in another tab; needs-review actions stay visible.
- **Ops:** the station must be restarted after a gateway-token change (docs and
  script message); a full backup without `openclaw` exits non-zero; token
  appends survive a missing final newline; restore checks the whole archive
  before deleting anything; the shipped `decisions.md` no longer carries a
  decision from a test run.

All 11 new tests fail on the previous code. The dashboard changes were also
checked live in Chromium.

## Slack integration (2026-10-11)

The first business integration posts approved reports to one Slack channel
through an incoming webhook. Slack's behaviour was taken from the official
`@slack/webhook` SDK source (POST JSON, `redirect: 'error'`, non-2xx is an
error, 5xx is transient, 4xx including 429 is final; incoming webhooks accept
`unfurl_links`/`unfurl_media`) and Slack's formatting rules (escape `&`, `<`,
`>` and nothing else).

This build container cannot reach Slack (DNS for `hooks.slack.com` fails), so
the automated tests use a stand-in that returns Slack's responses. Live check
in Chromium, on a copy of the station database with a fake webhook URL:
Integrations showed "set up (webhook …1234)". "Post to Slack…" on T-0008
produced an approval card with the exact message. The card and the task said
"waiting for your approval", and nothing was sent until "Approve & post". The
real send then failed with `could not connect (ENOTFOUND). Nothing was sent.`,
which the status line and task showed, and the post could be prepared again.
The webhook URL was absent from `/api/state`. The first real post happens on
the VPS.

An adversarial review (three reviewers, three skeptics per finding) found no
security issue. It found five low-severity problems, each confirmed by all
three skeptics and all fixed with tests:
- very long source URLs could push out the message footer or cut inside an
  `&amp;`;
- the `@` word joiner broke URLs such as `medium.com/@author`;
- the "sent within a few seconds" copy ignored a paused queue;
- an old error stayed on a post marked done;
- this file was out of date.

## Listing copy task type (2026-10-11)

A real run with the OpenClaw agents (T-0009, Etsy listing for a handmade mug,
about 85k reported tokens for plan, research, draft, and review):
- All four agent steps succeeded on the first attempt.
- The Researcher's six quotes all verified against the operator fact sheet.
- Citations and Etsy limits passed (title 79/140, 13 tags, longest 19/20).
- The Reviewer passed it.

The run found two problems, both fixed and tested:
- The Writer put a "DRAFT NOTE FOR THE OPERATOR… delete before publishing"
  paragraph inside the description, where it would have reached the
  paste-ready copy. Notes now have their own field, kept out of the copy, and
  the station flags note-like text in the copy.
- The Reviewer worried the `[S1]` markers would be published. Its
  instructions now say the station strips them.

After a restart on the fixed code, an operator "Request changes" sent the task
back to the Writer. The revision moved the note to "Notes for you" and dropped
an unsupported sentence about photos. Approving it in Chromium saved
`outputs/2026-10-11-t-0009-listing-handmade-speckled-mug.md`. "Copy listing
text" copied the paste-ready copy with no `[S#]` markers and no notes.

Demo Mode also ran a listing end to end in Chromium, and the station's
"3 to 5 bullet points" check showed on the approval card.

An independent code review then found five more problems, reproduced four of
them, and all five are fixed with tests:
- a `## ` line in the description could end or replace a section of the
  paste-ready copy after the checks had passed. Headings are now flattened,
  and the draft must read back exactly before it is accepted;
- a tag containing commas became several tags after the count check;
- product text like "[Galaxy S24]" was treated as a citation;
- research conflicts were hidden from the listing Writer. They are now shown,
  with S1 taking precedence;
- unticking every source type let the Commander query all types. It now
  means "only the URLs I paste".

Marketplace limits enforced, with their sources:
- eBay title 80: eBay Trading API docs.
- Amazon title 200: Seller Central product detail page rules.
- Etsy title 140, and 13 tags of up to 20 characters: consistent third-party
  seller guides. Etsy's own pages were not reachable, and the dashboard says
  so.
- Amazon bullet limits could not be confirmed and are not enforced.

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
