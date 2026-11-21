# Handoff: Groundwork (Codegeist 2026 entry)

Branch `claude/codegeist-2026-17e000`. All paths are relative to `codegeist/`.

## 1. What was built

**Feature:** Groundwork, a Forge app. It checks whether a Jira work item is ready to start, gives a
fix for each gap, and builds a context pack for people, the Rovo agent and MCP-connected agents.

Artifacts:
- `manifest.yml`: modules (`jira:issueContext`, 3 `action`, `rovo:agent`, `rovo:skill`, `rovo:mcp`),
  read-only scopes, `nodejs24.x` runtime. The app ID is a placeholder until `forge register`.
- `src/core/`: pure logic. `adf.ts` parses Atlassian Document Format, `detect.ts` holds the text
  heuristics, `readiness.ts` the 9 checks, score and verdict, `people.ts` ranks the people to ask,
  `contextPack.ts` builds the Markdown pack, `facts.ts` normalizes Jira JSON, and `graph.ts` holds
  the Teamwork Graph queries and parsers.
- `src/platform/`: the Jira REST and Teamwork Graph clients. Both run as the current user.
  `retry.ts` sends a graph query again when it fails in a way that can pass a moment later.
  `consent.ts` recognizes the one error no handler may catch (section 5 explains both).
- `src/service.ts`: load, enrich, score and pack, plus the project scan.
- `src/actions.ts`: the Rovo action handlers. The same handlers serve as the MCP tools.
- `src/resolvers.ts`, `src/frontend/`: the UI Kit panel and its resolver.
- `src/index.ts`: the function handlers named in the manifest.
- `resources/agent/groundwork-agent.txt`: the Rovo agent prompt.
- `skills/ready-check/SKILL.md`: the bundled `rovo:skill`.
- `agent-skills/groundwork-pickup/SKILL.md`: an open-source skill for outside coding agents.
- `test/`: 140 Vitest tests. `scripts/bundle-check.mjs` is the esbuild bundle and export check.
- Documents: `PLAN.md` (the one-page plan), `README.md` (install and setup), `SUBMISSION.md` (the
  Devpost text, judge instructions and video script), `OWNER-STEPS.md` (the owner's runbook),
  `PRIVACY.md`, `LICENSE` (MIT).

## 2. How to run it

Prerequisites:
- Node 22.23.4+ or 24.22.1+. The Forge CLI does not support Node 26. On this machine, Node 24.22.3
  is at `%APPDATA%\fnm\node-versions\v24.22.3\installation`.
- Forge CLI 13.3.0 or later. 15.1.0 is installed under that Node.
- For deploying only: the owner's free Atlassian account, an API token and a Forge demo site.

Setup (5 min, no login needed):
1. `$env:Path = "$env:APPDATA\fnm\node-versions\v24.22.3\installation;" + $env:Path`
2. `cd <worktree>\codegeist`
3. `npm ci`

Verify:
```
$ npm run check
Test Files  13 passed (13)
     Tests  140 passed (140)
all 4 manifest handlers are exported.
```

**[BLOCKED] Deploy needs a manual step:** `forge login` with the owner's own token. Claude must not
enter tokens. Every `forge` command takes 30 seconds to 2.5 minutes to start on this network.

## 3. What was tested

Test summary:
- Unit: 140 tests in 13 files, all passing. They include Forge's own `@forge/manifest` 13.9.0 full
  validation of `manifest.yml`.
- Type-check: `tsc` 6.0.3, and also the Forge CLI's bundled TypeScript 5.9.2 (what deploy uses).
- Lint: ESLint ran on 32 files with 0 issues. The esbuild bundle builds: backend 207 KiB, frontend
  601 KiB.

Test locations:
- `test/detect.test.ts` (15): acceptance criteria, reproduction steps, placeholders, open questions
- `test/readiness.test.ts` (16): every check, weights, verdicts, lite mode, graph-based checks, and
  "not checked" when a graph source did not answer
- `test/manifest.test.ts` (13): the Forge validator, module wiring and limits, scopes, `SKILL.md`
  format, and the panel-to-agent key match
- `test/service.test.ts` (18): fake Jira and graph clients, ARIs, failure handling, unread sources,
  the log line, the consent error, project scan, JQL
- `test/graph.test.ts` (15): query shapes and operation names, parsers, malformed data, which
  failures are transient, the wording for unread sources
- `test/actions.test.ts` (13): key and cloud ID resolution, result shapes, error messages, the
  consent error
- `test/retry.test.ts` (11): retries, the try and time limits, what is never retried, the schedule
- `test/adf.test.ts` (11): Markdown and plain-text rendering, mentions, URLs
- `test/facts.test.ts` (11): Jira JSON normalization, link direction, docs, custom fields
- `test/contextPack.test.ts` (7): sections, character budget, determinism
- `test/resolvers.test.ts` (5): the panel model, the gap line, the consent error
- `test/people.test.ts` (3) and `test/consent.test.ts` (2): ranking, and recognizing Forge's error

Known gaps:
- Nothing has run on a live Atlassian site: panel rendering, the Rovo agent and skill, the MCP tools
  in Rovo Studio.
- The Teamwork Graph queries match Atlassian's reference as of 2026-11-21 (section 5), but they have
  not been run against a live schema.
- The consent fix and the retries are covered by unit tests with Forge's own error class and with
  the error bodies developers reported. Neither has been seen working on a live site.
- `forge lint` needs a login, so it has not run. The same manifest validator already passed.
- The frontend has no unit tests; only its pure helper `src/frontend/agent.ts` is tested.

To run tests:
```
$ npm test
```

## 4. Deployment checklist

`OWNER-STEPS.md` has the full owner runbook. In short:

Pre-deployment (owner):
- [ ] Confirm eligibility: the age of majority is 19 in some provinces, and Quebec is excluded.
- [ ] Decide on the rules' "Entrant's ideas and creativity" clause and on the `LICENSE` holder.
- [ ] Create a free Atlassian account, run `forge login` with your own token, then
      `forge site provision`.
- [ ] Run `forge register`, then commit the new app ID in `manifest.yml`.
- [ ] Never add a payment method in the developer console.

During deployment (Claude, on the owner's explicit yes):
- [ ] `npm ci`, `npm run check`, `forge lint`
- [ ] `forge deploy`, then `forge install --demo-site`, choosing Jira and approving the scopes.

Post-deployment verification:
- [ ] The **Ready check** panel renders on a work item and re-checks after an edit.
- [ ] The Rovo **Groundwork** agent answers its four conversation starters.
- [ ] The three tools appear in Rovo Studio under **Connected apps**, **Groundwork**.
- [ ] The panel footer shows Teamwork Graph data. If not, check the scopes under **Connected apps**,
      then **Permissions**, and try the queries in the Query Builder.
- [ ] Deploy to production (`forge deploy -e production`), set **Distribution** to **Sharing**, and
      copy the installation link.

Rollback plan:
1. `forge uninstall`: removes the app from the demo site.
2. In the developer console, set **Distribution** to **Not sharing**: stops new installs from the
   link.
3. `git revert <commit>`, then `forge deploy`: ships the previous code.

Estimated time: 10 minutes, plus the CLI's slow start-up. The app stores no data, so nothing needs
restoring.

## 5. Known issues and next steps

✅ Completed:
- A ready check with 9 explainable checks and type-aware rules (bugs, sub-tasks, epics).
- A context pack with a character budget and ranked people to ask.
- One core behind three surfaces: the panel, the Rovo agent with its skill, and MCP tools with an
  open-source skill.
- Teamwork Graph enrichment that degrades gracefully when it returns nothing, retries transient
  failures, and reports a source it could not read as "not checked", never as empty.
- Every handler lets Forge's consent error through, so a person's first use can set up access.
- The plan, README, Devpost draft, video script, owner steps and privacy statement.

⚠️ Known limitations:
- Read-only: Groundwork drafts fixes in Rovo but never edits Jira.
- Project scans skip comments, remote links and the graph ("lite" checks).
- The checks are fixed: no per-project definition of ready yet.
- Installing needs an org admin, because of the Teamwork Graph scopes.
- A missing graph scope returns empty results, which look the same as "nothing linked".
- Not deployed anywhere yet. Performance and cost have not been measured.

📋 Next steps (priority order):
1. Owner steps 0 to 5: eligibility, account, login, site and register (about 30 min, owner).
2. Deploy, install and the step 7 verification on the demo site (about 30 min).
3. Fix whatever the live run shows (1 to 2 h). The field names now match the reference, so the
   likelier surprises are the platform issues listed below.
4. Create the demo data, then record and upload the video (about 2 to 3 h, owner).
5. Production deploy, installation link, Devpost form, then submit by December 18 (about 1 h, owner).

🔎 Platform behaviour checked on 2026-11-21 (docs and developer reports; nothing below was run live):

- **The reference matches.** All five curated queries, their arguments, every selected field, the
  `first` cap of 25, the seven graph scopes and the three ARI formats agree with
  [Curated queries](https://developer.atlassian.com/platform/teamwork-graph/curated-queries/),
  [Scopes](https://developer.atlassian.com/platform/teamwork-graph/scopes/),
  [Understanding ARIs](https://developer.atlassian.com/platform/teamwork-graph/understanding-aris/)
  and the [object types](https://developer.atlassian.com/platform/teamwork-graph/api-reference/object-types/overview/).
- **No breaking change is announced.** The API is in Preview, and breaking changes get at least a
  month's notice in the [changelog](https://developer.atlassian.com/platform/teamwork-graph/changelog/).
  Its last entry is from 15 October 2026. Read it again before submitting, and while judging runs.
- **First use sets up access through an error.** `api.asUser()` throws `NEEDS_AUTHENTICATION_ERR`
  when a person's access is not set up yet, and Forge acts on it only if it leaves the function
  ([Atlassian's answer](https://community.developer.atlassian.com/t/forge-app-providers-return-needs-authentication-err-authentication-required/79671)).
  The panel resolver and the three actions used to catch it and answer "could not load". They now
  rethrow it. Do not add a catch-all in front of them.
- **Some sites refuse a share of identical graph reads.** One developer measured about 70% of reads
  on a `forge site provision` demo site answering HTTP 200 with "User is not permitted to query this
  organization", while the rest passed in the same second
  ([report](https://community.developer.atlassian.com/t/teamwork-graph-curated-fields-intermittently-return-user-is-not-permitted-to-query-this-organization/103690),
  unanswered so far). `src/platform/retry.ts` tries up to 8 times inside 6 seconds. To tune it,
  change `DEFAULT_RETRY`.
- **A failed graph read is HTTP 200.** Rate limits and a bad operation name come back the same way
  ([write-up](https://community.developer.atlassian.com/t/reading-the-teamwork-graph-api-from-a-forge-rovo-agent-the-failures-that-return-http-200-or-an-empty-list/103629)).
  Groundwork reads the GraphQL errors, and a test checks the `[company]_[operation]` names.
- **Page owners can be null.** A page owned or edited by an app account returns a null user node
  with a non-null error
  ([report](https://community.developer.atlassian.com/t/teamwork-graph-confluencepageowners-always-returns-a-null-user-node-non-null-violation-contributors-partially-null-atlassianteamsbyspace-works/103766)).
  Groundwork skips null nodes and keeps the rest.
- **Outside MCP clients can get "User consent required".** Atlassian confirmed this bug on
  2026-11-19 for apps with both Jira and Confluence scopes; Groundwork has a Confluence graph scope
  ([thread](https://community.developer.atlassian.com/t/forge-rovo-asuser-tools-always-return-mcp-unauthenticated-user-consent-required-consent-does-not-persist/104088)).
  Their workaround is to use the app's own agent once in Rovo Chat, which is why the judge
  instructions put Rovo Chat before MCP.
- **Rovo is stricter than the limits page.** It gave up on an action after about 20 seconds and
  near 1 MB in the same write-up. Groundwork's retry budget is 6 seconds and a pack is 8,000
  characters at most.
- **A scope change is a major version.** After one, run `forge deploy`, then
  `forge install --upgrade`.

⚡ Quick wins:
- `jira:issueContext` `dynamicProperties`: show the score badge on the collapsed panel (1 h).
- A Jira trigger that checks readiness when a work item moves to "Ready for development" (2 h).
- Per-project check weights stored in app properties (3 h).
