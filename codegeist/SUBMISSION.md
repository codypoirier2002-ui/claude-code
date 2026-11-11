# Devpost submission draft: Groundwork

Everything below is a draft for the owner to read, edit and submit. Replace the `<…>` placeholders
after deploying.

## Project basics

- **Name:** Groundwork
- **Tagline:** Know whether a Jira work item is ready before anyone, person or AI agent, starts it.
  Explainable ready checks and graph-powered context packs in Jira, Rovo and any MCP client.
- **Category:** Apps for Software Teams
- **Bonus prizes:** Best Agents; Best app with Atlassian MCP; Best Teamwork Graph integration (only if
  graph data shows on the demo site)
- **Built with:** atlassian-forge, jira, rovo, rovo-agents, rovo-skills, rovo-mcp, teamwork-graph,
  ui-kit, typescript, react, vitest
- **Video:** `<YouTube URL, public>`
- **Installation link:** `<from the developer console, Distribution, Sharing>`
- **Code (optional):** `<GitHub link to the codegeist folder, if pushed>`

**AI assistance** (owner: edit the second sentence so it matches what you actually did before you
submit): Groundwork was built with AI assistance. Claude Code, Anthropic's coding agent, proposed the
idea and wrote the code, tests and documentation; `<describe your own part, for example "I chose the
direction, reviewed the code, deployed and tested the app on my site, and recorded the demo">`.

---

## Inspiration

Every team knows the moment: someone picks up a work item, opens it, and finds a one-line title.
There are no acceptance criteria, the spec is in a Confluence page nobody linked, a blocker is still
open, and the only person with the background is not on the ticket. A person loses an hour asking
around. An AI coding agent does something worse: it does not ask, it guesses. The team then reviews
and reworks the guess.

As teams hand more work items to agents, the quality of the work item decides the quality of the
result. Atlassian already holds the context those agents need, in Jira, in Confluence, and in the
Teamwork Graph that connects them. Groundwork puts that context to work before the work starts.

## What it does

Groundwork answers two questions for any Jira work item: **"Can this be started?"** and
**"What does whoever starts it need to know?"**

- **Ready check.** Nine explainable checks produce a 0–100 score and a verdict: Ready to start,
  Almost ready, Not ready or Blocked. The checks are a clear title, enough detail, acceptance
  criteria (or, for bugs, steps to reproduce with expected and actual results), no open blockers, a
  purpose (epic or linked goal), reference docs, a size estimate, no unanswered question in the latest
  comment, and no pull request already open on the item. Every gap says what was found and how to fix
  it.
- **Context pack.** One compact Markdown brief: the readiness gaps, why the work matters (epic,
  goals, owning team), the description and acceptance criteria, linked work and blockers, linked docs,
  pull requests, the recent discussion, and **people to ask**, ranked with reasons such as "owns the
  linked spec" or "reported the issue". It is sized for an AI context window and still easy for a
  person to read.
- **Ready work in a project.** Ranks a project's to-do work by readiness, so a lead, or an agent
  choosing its next task, picks something that can actually be started.

It works in three places, all backed by the same three read-only actions:

1. A **Ready check panel** on every Jira work item, which re-checks itself after an edit.
2. The **Groundwork Rovo agent**, with a reusable `ready-check` skill. It explains gaps and drafts
   the missing acceptance criteria or steps to reproduce for the user to paste.
3. **MCP tools** through `rovo:mcp`, for custom agents in Rovo Studio and for any outside MCP
   client. An open-source `SKILL.md` teaches coding agents to fetch the context pack, and to stop when
   a work item is not ready, before they write code.

## How we built it

- **Forge, Node 24, TypeScript.** One shared core, with six module types around it: a
  `jira:issueContext` panel built with UI Kit, a resolver, three `action` modules, `rovo:agent`,
  `rovo:skill` and `rovo:mcp`.
- **Jira REST API v3** for the work item, its links and remote links, and its latest comments. All
  calls run as the current user, so nobody sees more than they already could. A small Atlassian
  Document Format (ADF) renderer turns descriptions into plain text for the checks and Markdown for the
  pack.
- **Teamwork Graph API** curated queries: `jiraWorkItemGoals`,
  `jiraWorkItemLinkedExternalPullRequests`, `confluencePageOwners`, `confluencePageContributors` and
  `atlassianTeamsBySpace`. Each runs on its own with a minimal field selection. A failure or a missing
  scope degrades one enrichment, never the whole check.
- **Deterministic core.** The checks, scoring, people ranking and context pack are pure functions with
  no language model inside. The same work item always gets the same answer, and every point of the
  score can be explained. Rovo supplies the conversation; Groundwork supplies the facts.
- **Trust by design.** Read-only scopes and `GET` actions only. No storage and no outside network
  calls, so the app runs entirely on Atlassian. No Forge LLM API, which keeps the platform cost at $0.
- **Quality.** Vitest unit tests cover ADF parsing, every check, scoring and verdicts, people ranking,
  the pack builder, the graph parsers, the service layer (with fake Jira and graph clients) and the
  action handlers. A manifest test runs Forge's own manifest validator, then checks the module wiring,
  the name limits, the skill format and the scopes. ESLint, `tsc` and an esbuild bundle check run
  before every deploy.

## Challenges we ran into

- **An empty graph result is ambiguous.** When a Teamwork Graph scope is not granted, queries succeed
  with empty data instead of failing. Groundwork never treats "no graph data" as a failure. The panel
  says what the graph returned, and checks that need it show as "not checked".
- **Explaining "ready" without being preachy.** Different work types need different checks. Bugs need
  reproduction steps, not user stories. Sub-tasks get a lighter touch, and epics need success
  criteria and a goal. Every warning had to come with a concrete fix.
- **Keeping one answer across three surfaces.** The panel, the agent and the MCP tools share the same
  actions and service layer, so a person and an agent never get different verdicts.
- **Context windows are finite.** The pack has a hard character budget. It gives back description
  space first and never drops the parts an agent needs most: gaps, blockers and people.

## Accomplishments that we're proud of

- A coding agent outside Atlassian can now ask "is KAN-12 ready, and what do I need to know?" and
  get the same graph-backed answer a teammate sees in Jira.
- Every score is explainable down to the check, with a fix for each gap.
- It works on a plain Jira site with no setup, and gets richer as the Teamwork Graph fills in.

## What we learned

- Rovo skills and MCP tools are a natural pair. Actions provide the facts, the skill provides the
  playbook, and the same actions serve every agent.
- Curated Teamwork Graph queries are the quickest way to add org context, provided the app is built
  for partial answers.

## What's next

- Team-specific definitions of ready: choose and weight the checks per project.
- An automation trigger that checks readiness when a work item moves to "Ready for development".
- A project page that shows backlog readiness over time.
- Marketplace listing.

---

## How Groundwork meets the technology requirement

Groundwork is a Forge app (`manifest.yml`, Node 24 runtime) that integrates with **Jira**: a
`jira:issueContext` panel, plus the Jira REST API for work items, links, remote links and comments.
It also integrates with **Rovo**, through `rovo:agent`, `rovo:skill`, three `action` modules and
`rovo:mcp`, and with the **Teamwork Graph**, through the Teamwork Graph API's curated queries for goals,
pull requests, Confluence page owners and contributors, and teams. It was built new during the
submission period.

## Bonus prize write-ups

**Best Agents (Rovo).** The Groundwork agent (`rovo:agent`) has four jobs: check readiness, build a
context pack, find ready work in a project, and draft missing acceptance criteria. Its `ready-check`
`rovo:skill` is a reusable, task-specific playbook for a definition-of-ready review, declared with
its tool dependencies, which any Forge agent can load. The three actions (`check-issue-readiness`,
`get-context-pack`, `list-ready-issues`) return structured, explainable results. They are read-only
`GET` actions, so they are safe for any agent to call, including agents run from automation.

**Best app with Atlassian MCP.** The same three actions are exposed as tools through `rovo:mcp`. They
are available to custom agents in Rovo Studio and, once an admin turns on external exposure, to any
MCP client at `https://mcp.atlassian.com/forge/<appId>`. The repository includes an open-source
`agent-skills/groundwork-pickup/SKILL.md`, which users can add to their own coding agents. It makes
the agent fetch the context pack before it writes code, stop on Blocked or Not ready, and turn
acceptance criteria into tests.

**Best Teamwork Graph integration.** Groundwork reads the graph to answer "why does this matter?"
(goals linked to the work item, teams linked to the project), "who knows?" (owners and contributors
of linked Confluence pages), and "is someone already on it?" (pull requests linked to the work item).
It uses five curated queries, each run as the user with per-object read scopes. Graph data feeds two
checks (Purpose is clear, No duplicate work), the people ranking and the context pack, and the app
degrades gracefully when a scope is not granted.

---

## Testing instructions for judges

1. Open the installation link: `<link>`. Install on a site where you are an **organization admin**,
   because the Teamwork Graph scopes need one. Choose **Jira**.
2. Open any work item. In the right-hand column, under the fields, expand **Ready check**. You will
   see a score, a verdict, the checklist with fixes and the people to ask.
3. Select **View context pack** to see the Markdown brief that agents receive.
4. Edit the work item's description, for example by adding an "Acceptance criteria" heading with two
   bullet points. The panel re-checks within a few seconds.
5. Open **Rovo Chat** and pick the **Groundwork** agent. Try:
   - "Is this work item ready to start?" (while viewing a work item)
   - "Which work items in `<project key>` are ready to start?"
   - "Draft the missing acceptance criteria for this work item"
6. MCP: in Rovo, choose **Create agent**, then **Tools**, **Add tools**, **Connected apps**,
   **Groundwork**. Add the three tools and ask the new agent "Get the context pack for
   `<work item key>`".
7. Optional, for outside MCP clients: in admin.atlassian.com, go to **Apps**, **Sites**, your site,
   **Connected apps**, **Groundwork**, **Tools**, and turn the tools on. Then connect a client to
   `https://mcp.atlassian.com/forge/<appId>`.

Groundwork is read-only and stores nothing. If the panel footer says the graph returned nothing,
either nothing is linked yet or the graph scopes were not granted. Every Jira-based check still works.

---

## Demo data to create before recording

Create these in one Jira project on the demo site (the examples use `KAN`; use whatever key the site
has).

1. **Confluence page** "Audit log export spec": a short page with a "Requirements" section. You will
   be its owner.
2. **Goal** "Pass the SOC 2 audit", if Goals are available on the site, linked to the epic in step 3.
3. **Epic** "Compliance reporting".
4. **Story A, ready:** "Let admins export audit logs as CSV", under the epic, 3 story points, with
   the Confluence page linked (**Link**, then **Confluence page**). Description:

   > Compliance officers hand audit logs to external auditors every quarter. Today an engineer exports
   > them from the database by hand, which takes half a day and is easy to get wrong.
   >
   > **Acceptance criteria**
   > - Admins can export the audit log for a chosen date range as CSV
   > - The export includes actor, action, target and timestamp columns
   > - Non-admins do not see the export button

5. **Story B, not ready:** "Fix export", with no description, no estimate and no epic.
6. **Task C, the blocker:** "Decide the audit log retention policy", in progress.
7. **Story D, blocked:** "Show the audit log retention period", under the epic, linked "is blocked
   by" Task C, with a short description and acceptance criteria.
8. **Bug E, almost ready:** "CSV export fails for ranges over 90 days". Description: numbered steps
   to reproduce with no "Expected" or "Actual" lines. Then add a comment: "Does this also happen for
   JSON exports?"

## Demo video script (target 3:30, hard limit under 5:00)

| # | Time | Screen | Voice-over |
| --- | --- | --- | --- |
| 1 | 0:00–0:12 | Title card: "Groundwork: make every Jira work item ready to start." | "AI agents can write code. They can't guess what your team meant. Groundwork makes sure nobody, person or agent, starts work without the context." |
| 2 | 0:12–0:30 | Jira: open Story B, "Fix export", which has no description. | "Here's a work item a teammate, or a coding agent, could pick up right now. One title, nothing else. Whoever starts it will guess." |
| 3 | 0:30–0:55 | Expand **Ready check**: Not ready, a low score, failed checks with fixes. | "Groundwork's ready check reads the work item and its links. Nine explainable checks, a score, and for every gap a concrete fix. No black box: every point comes from a rule you can read." |
| 4 | 0:55–1:30 | Open Rovo Chat, Groundwork agent: "Draft the missing acceptance criteria for this work item." Paste the draft into the description. The panel re-checks and the score jumps. | "The Groundwork agent in Rovo drafts what's missing as Given, When, Then, marking anything it assumed. I paste it in, and the panel re-checks on its own." |
| 5 | 1:30–1:55 | Open Story D: verdict **Blocked**, naming Task C, with the people to ask. | "Story D looks fine, but it's blocked by an open decision. Groundwork says so and tells me who to ask, ranked by evidence such as who owns the linked spec." |
| 6 | 1:55–2:25 | Open Story A: Ready to start. Footer shows Teamwork Graph data (goal, page owner, team). Select **View context pack** and scroll. | "Story A is ready. The Teamwork Graph adds why it matters, the SOC 2 goal, plus the owning team and the spec's owner. Everything a newcomer needs is in one context pack, sized for an AI context window." |
| 7 | 2:25–3:00 | Rovo: **Create agent**, **Tools**, **Connected apps**, **Groundwork**: add the three tools. Ask "Which work items in KAN are ready to start?" and get a ranked table. Then ask for the context pack of KAN-A. | "The same actions are MCP tools. Any custom agent in Rovo Studio can use them, and so can any MCP client outside Atlassian. Here an agent picks the next work item that can actually be started." |
| 8 | 3:00–3:15 | The repository open at `agent-skills/groundwork-pickup/SKILL.md`. | "We ship an open-source skill for coding agents. Fetch the context pack before writing code, stop if the work item is blocked or not ready, and turn acceptance criteria into tests." |
| 9 | 3:15–3:30 | Simple diagram: Jira and Teamwork Graph, then the Groundwork core, then the panel, Rovo agent and MCP. Badges: read-only, stores nothing, runs on Atlassian. | "One deterministic core, three surfaces. Read-only scopes, no data stored, nothing leaves Atlassian." |
| 10 | 3:30–3:40 | Closing card with the name and tagline. | "Groundwork: build with context, ship with confidence." |

**Recording notes**

- If the panel footer shows no Teamwork Graph data on your site, keep shot 6 but change its line to:
  "Story A is ready. When goals, page owners and teams are linked in the Teamwork Graph, they show up
  here and in the pack too." Don't claim graph data the screen doesn't show, and in that case leave
  the Teamwork Graph bonus unticked.
- Record at 1920×1080. Zoom the browser to 125% so the panel is readable.
- Create the demo data first. Run each prompt once before recording, so Rovo's answers are familiar.
- Show only Atlassian products and Groundwork, with no other companies' logos or tools. Use no music,
  or music you have the rights to.
- Upload to YouTube as **Public**, and keep it under 5 minutes.
