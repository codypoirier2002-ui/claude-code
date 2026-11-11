---
name: groundwork-pickup
description: Before writing code for a Jira work item, fetch its Groundwork context pack over MCP and stop to ask a person when the work item is not ready. Use when the user asks you to start, implement or fix a Jira work item such as KAN-12, or when the branch name contains a work item key.
license: MIT
compatibility: Needs the Groundwork Forge app on the Jira site, with its tools turned on for external MCP clients and the server https://mcp.atlassian.com/forge/<appId> added to your MCP client.
metadata:
  app: Groundwork
  version: "1.0"
---

# Pick up a Jira work item with Groundwork

A coding agent that starts from a vague work item guesses, and the team pays for the guess in
review and rework. This skill makes you start from the same context a teammate would have, and
makes you stop when the work item is not ready.

## When to use

- The user asks you to start, implement or fix a Jira work item, for example "do KAN-12".
- The current branch name contains a work item key, for example `feature/KAN-12-export-csv`.

## Steps

1. Find the work item key in the request or the branch name. If there is none, ask for it.
2. Call the Groundwork tool `get-context-pack` with `issueKey`. Read the whole pack before you plan.
3. Act on the verdict in the "Readiness" section:
   - **Blocked**: stop. Tell the user which blockers are open. Do not start the work.
   - **Not ready**: list the gaps and ask the user to close them, or to confirm your assumptions
     explicitly, before you write any code.
   - **Almost ready**: list the gaps as assumptions in your plan and ask the user to confirm them.
   - **Ready to start**: go ahead.
4. Plan from the pack. Turn each acceptance criterion into a test. Read the linked docs the user
   can share with you. Respect the open questions instead of answering them yourself.
5. When you need an answer, use "People to ask" to tell the user who can give it.
6. At the end, say which acceptance criteria you covered and how you verified each one.

## Tools

Your client may show these with a prefix, for example `groundwork:get-context-pack`.

| Tool | Input | Returns |
| --- | --- | --- |
| `get-context-pack` | `issueKey` | `contextPack` (Markdown), `score`, `verdictLabel` |
| `check-issue-readiness` | `issueKey` | `score`, `verdict`, `gaps` (each with a fix), `peopleToAsk`, `nextStep` |
| `list-ready-issues` | `projectKey`, optional `limit` (1 to 25) | to-do work items ranked by readiness, ready ones first |

Use `list-ready-issues` when the user asks "what can I pick up next?" in a project.

If a tool returns an `error` field, tell the user what it says. The most common cause is that you
do not have permission to view the work item.

## Setup

1. A Jira site admin installs the Groundwork app. In Atlassian Administration, under **Apps >
   Sites > your site > Connected apps > Groundwork**, they turn on the tools for external MCP
   clients.
2. Add `https://mcp.atlassian.com/forge/<appId>` to your MCP client as a remote (HTTP) server and
   complete the Atlassian sign-in. `<appId>` is the UUID at the end of `app.id` in the app's
   `manifest.yml`.
3. Copy this `groundwork-pickup` folder into your agent's skills folder.

Groundwork is read-only. It never changes Jira, and every result is filtered by your own Jira
permissions.
