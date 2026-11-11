# Groundwork: plan for a Codegeist 2026 entry

**Pitch:** Groundwork checks whether a Jira work item is ready to start, explains every gap in plain
language, and packs the context someone needs to start it. That someone can be a person, a Rovo
agent, or an outside AI coding agent connected over MCP.

**Category:** Apps for Software Teams. **Bonus prizes it qualifies for:** Best Agents (`rovo:agent`
+ `rovo:skill` + `rovo:action`), Best app with Atlassian MCP (`rovo:mcp` + an open-source
`SKILL.md`), Best Teamwork Graph integration (reads the graph). A submission can win one bonus, so
Agents and MCP are the two to lead with: both run on the same three actions.

## The problem

Work items often get picked up before they are ready. The acceptance criteria are missing, a blocker
is still open, the spec lives in a Confluence page nobody linked, or the only person who knows the
background is not on the ticket. A person loses an hour asking around. An AI coding agent is worse
off: it does not ask, it guesses, and the team reviews and reworks the guess. The more work teams hand
to agents, the more the quality of the work item decides the quality of the result.

## Who it is for

- **Developers** picking up a work item, who want to know "can I start, and where is the context?"
- **Tech leads and product owners** grooming a backlog, who want a quick definition-of-ready check
  with concrete fixes, not a lecture.
- **Teams handing work to AI coding agents** (Rovo Dev or any MCP client), who want the agent to start
  from the same context a teammate would.

## What it does

1. **Ready check.** Eight to nine explainable checks per work item: clear title, enough detail,
   acceptance criteria (or, for bugs, steps to reproduce plus expected and actual results), no open
   blockers, a purpose (parent epic or linked goal), reference docs, a size estimate, no unanswered
   question in the latest comment, and no pull request already open on it. The result is a 0–100
   score and a verdict: Ready, Almost ready, Not ready or Blocked. Each gap comes with a fix.
2. **Context pack.** One compact Markdown brief with the purpose, the description, acceptance criteria,
   blockers, linked docs, linked pull requests, recent discussion, the owning team, and **people to ask**,
   each ranked with the reason ("owns the linked spec", "reported the issue"). It is sized for an LLM
   context window and readable by a person.
3. **Ready work in a project.** Ranks a project's open work by readiness, so a lead or an agent can pick
   the next item that can actually be started.

## Forge modules

| Module | Use |
| --- | --- |
| `jira:issueContext` (UI Kit) | A "Ready check" panel on every work item: score, checklist with fixes, people to ask, and a context-pack viewer. |
| `action` ×3 | `check-issue-readiness`, `get-context-pack`, `list-ready-issues`. All three are read-only `GET` actions. |
| `rovo:agent` | The "Groundwork" agent in Rovo Chat: runs checks, explains gaps, and drafts the missing acceptance criteria as text for the user to paste. |
| `rovo:skill` | `ready-check`, a reusable playbook for a definition-of-ready review that any Forge agent can load. |
| `rovo:mcp` | Exposes the three actions as tools for custom agents in Rovo Studio and for MCP clients outside Atlassian. |
| `function` | Resolver plus one handler per action, on Node 24. |

**Data.** The core needs only the Jira REST API: the work item, its links, remote links and comments.
It works on any plain Jira site without setup. The **Teamwork Graph API** (curated queries) adds goals
linked to the item, pull requests linked to it, the owners and contributors of linked Confluence pages,
and the teams linked to the project. A missing graph scope returns empty results rather than an error,
so the panel says "no graph data returned" instead of failing.

**Guardrails.** Read-only scopes. No Forge LLM API, which has no free tier. No storage, containers or
triggers. Data never leaves Atlassian, so the app qualifies as Runs on Atlassian. Expected Forge cost
is $0, well inside the free allowance.

## Why it can score on each criterion

- **Technological implementation.** It uses six module types with one shared core: UI Kit,
  resolvers, actions, agent, skill and MCP. It combines Jira REST with Teamwork Graph curated queries,
  and it degrades gracefully when graph scopes are not granted. Unit tests cover the scoring, the
  parsing of Atlassian Document Format (ADF) and the pack builder.
- **Design.** It is one coherent flow across three surfaces (panel, chat, MCP), and every check shows
  a status, a reason and a fix. The panel has proper loading, error and empty states.
- **Potential impact.** It addresses a daily, specific cost: starting work without context. That cost
  grows as teams delegate work items to AI agents. Groundwork plugs into the standup and grooming
  routines teams already have.
- **Innovation.** Definition-of-ready checklists exist. Groundwork's angle is new: the same
  graph-backed readiness and context pack serves people, Rovo, and any MCP-connected coding agent. A
  shipped `SKILL.md` teaches outside agents to "check readiness before you code".
- **Presentation.** A two-and-a-half-minute story: a vague work item, then the fixes, then an agent
  starting from a full context pack. Every shot maps to one feature. The script is in `SUBMISSION.md`.

## Out of scope for the first version

Writing to Jira (posting comments, editing descriptions), Confluence-installed surfaces, persisted
Cypher queries (they need registration in the owner's Query Builder), and a Marketplace listing.

## What only the owner's site can confirm

Deploy and install. That the Teamwork Graph queries return data on the demo site. That the agent and
its MCP tools appear in Rovo Studio. That the panel renders. Each item is a step in `OWNER-STEPS.md`.
