# Groundwork

**Make every Jira work item ready to start, for people and for AI coding agents.**

Groundwork is an Atlassian Forge app. It checks whether a Jira work item is ready to start, explains
every gap with a fix, and builds a compact **context pack** that a person, a Rovo agent or any
MCP-connected coding agent can start from. The core reads Jira; the Teamwork Graph adds linked
goals, pull requests, the owners of linked Confluence pages, and owning teams.

It shows up in three places, all backed by the same three read-only actions:

| Surface | What you get |
| --- | --- |
| **Ready check panel** on every work item (right side, under the fields) | A 0–100 score, a verdict, a checklist with fixes, the people to ask, and a context-pack viewer. It refreshes after the work item is edited. |
| **Groundwork agent** in Rovo Chat | "Is this ready to start?", "Build a context pack", "Which work items in KAN are ready?", "Draft the missing acceptance criteria". |
| **MCP tools** (`rovo:mcp`) | `check-issue-readiness`, `get-context-pack` and `list-ready-issues` for custom agents in Rovo Studio, and for outside MCP clients at `https://mcp.atlassian.com/forge/<appId>`. |

`agent-skills/groundwork-pickup/SKILL.md` is an open-source skill that teaches any coding agent to
fetch the context pack, and to stop when the work item is not ready, before it writes code.

## The checks

| Check | Weight | What passes |
| --- | --- | --- |
| Clear title | 10 | At least 3 words, no placeholder such as "TBD" |
| Enough detail | 15 | A description of at least 25 words |
| Done is defined (stories and tasks) | 25 | Acceptance criteria: a field, a heading, Given/When/Then, or a checklist |
| Reproducible (bugs) | 25 | Numbered steps plus expected and actual results |
| No open blockers | 20 | Every "is blocked by" or "depends on" link is done |
| Purpose is clear | 10 | A parent epic, or a goal linked in the Teamwork Graph |
| Reference material | 5 | A linked Confluence page, design or doc |
| Sized | 5 | Story points or a time estimate, under 13 points |
| No open questions | 5 | No unanswered "?" in the latest comment, and no "TBD" in the description |
| No duplicate work | 5 | No pull request already open on a to-do item (Teamwork Graph) |

A pass earns the full weight and a warning earns half. Checks that cannot run are left out of the
score. The verdicts are Ready to start (80 or more with no failed check), Almost ready (55 or more),
Not ready, and Blocked (any open blocker, whatever the score).

## Folder layout

```text
codegeist/
├── manifest.yml               Forge modules, scopes and runtime
├── src/
│   ├── core/                  Pure logic: ADF parsing, checks, scoring, people, context pack, graph parsing
│   ├── platform/              Jira REST and Teamwork Graph clients (run as the current user)
│   ├── service.ts             Load, enrich, score and pack; shared by every surface
│   ├── actions.ts             Rovo actions, which are also the MCP tools
│   ├── resolvers.ts           Resolver for the panel
│   ├── frontend/index.tsx     UI Kit panel
│   └── index.ts               Function entry points named in manifest.yml
├── resources/agent/           The Rovo agent's prompt
├── skills/ready-check/        rovo:skill bundled with the app
├── agent-skills/              Open-source SKILL.md for outside agents
├── test/                      Vitest unit tests, including the Forge manifest validator
└── scripts/bundle-check.mjs   Bundles both entry points and checks the handlers
```

## Requirements

- **Node.js 22 or 24 LTS.** The Forge CLI supports 22.23.4 or later, or 24.22.1 or later. It does not
  support Node 26. On this machine, Node 24.22.3 is installed with
  [fnm](https://github.com/Schniz/fnm) in `%APPDATA%\fnm\node-versions\v24.22.3\installation`.
- **Forge CLI 13.3.0 or later.** 15.1.0 is installed under that Node.
- **A free Atlassian account and a Forge demo site.** `forge site provision` creates the demo site,
  which has Jira, Confluence, Jira Service Management and Rovo with seeded data, and lasts 90 days.

To use Node 24 in a PowerShell window, run this first in each new window:

```powershell
$env:Path = "$env:APPDATA\fnm\node-versions\v24.22.3\installation;" + $env:Path
node --version    # v24.22.3
```

## Develop and check locally

No Atlassian login is needed for this part.

```powershell
npm ci
npm run check     # eslint, tsc, vitest and the bundle check, in that order
```

You can also run them one at a time: `npm run lint`, `npm run typecheck`, `npm test` and
`npm run bundle-check`. The tests include the Forge CLI's own full manifest validator
(`@forge/manifest`), so manifest mistakes fail here instead of at `forge deploy`. `forge lint` runs the
same validator plus Forge's code rules, but it needs `forge login` first.

## Deploy and install

These steps need the owner's Atlassian login. `OWNER-STEPS.md` walks through them in order.

```powershell
forge login                      # your email and your own API token
forge site provision             # once: creates the free demo site
forge register                   # once: gives this app your own app ID in manifest.yml
forge deploy                     # development environment
forge install --demo-site        # choose Jira when asked
```

To share with judges, deploy to production, then turn on sharing in the developer console:

```powershell
forge deploy -e production
forge install -e production --demo-site
```

Then open developer.atlassian.com/console/myapps, choose **Groundwork**, then **Distribution**, and set
it to **Sharing**. Copy the installation link it gives you.

**Installing needs an organization admin.** The Teamwork Graph scopes require one at install time.
The owner of a demo site is its org admin.

## Use it

1. **Panel.** Open any Jira work item. Under the fields on the right, expand **Ready check**.
2. **Rovo.** Open Rovo Chat, pick the **Groundwork** agent, and use a conversation starter.
3. **Rovo Studio.** Create an agent, then go to **Tools**, **Add tools**, **Connected apps**,
   **Groundwork**, and add the three tools.
4. **Outside MCP clients (optional).** In admin.atlassian.com, go to **Apps**, **Sites**, your site,
   **Connected apps**, **Groundwork**, **Tools**, and turn the tools on. Then add
   `https://mcp.atlassian.com/forge/<appId>` as a remote MCP server in the client. `<appId>` is the
   UUID at the end of `app.id` in `manifest.yml`. Copy `agent-skills/groundwork-pickup` into the
   client's skills folder.

## Teamwork Graph notes

- Groundwork uses curated queries only: `jiraWorkItemGoals`, `jiraWorkItemLinkedExternalPullRequests`,
  `confluencePageOwners`, `confluencePageContributors` and `atlassianTeamsBySpace`. These need no
  registration. Each runs on its own with a small field selection; the queries are in
  `src/core/graph.ts`.
- A scope that was not granted returns **empty** results, not an error. The panel then says so in
  its footer, and the checks that need the graph show as "not checked" instead of failing.
- Results are filtered by the user's own permissions.

## Cost and data

- All scopes are read-only, and actions use the `GET` verb.
- There is no storage, no outside network access, no Forge LLM API (which has no free tier) and no
  containers.
- Each check is one function run at 256 MB that makes up to 3 Jira calls and 9 Teamwork Graph
  calls. Its duration has not been measured on a live site yet. Even at a pessimistic 5 seconds, that
  is 1.25 GB-seconds a check, and Forge's free allowance of 200,000 GB-seconds a month covers about
  160,000 checks. Expected cost is **$0**. Rovo's own AI usage is billed to the site's Rovo allowance,
  not to the app developer.
- `PRIVACY.md` has the full privacy statement.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `forge` is not recognized, or says the Node version is unsupported | Run the `$env:Path` line above in the window first. |
| A `forge` command seems to hang | Every command takes from 30 seconds to a few minutes to start on a slow connection. Wait before you cancel it. |
| The panel says the work item was not found | The signed-in user cannot view it, or the app is not installed on that site. |
| The footer says "no linked goals, pull requests, page owners or teams" | Either nothing is linked yet, or the graph scopes were not granted. In admin.atlassian.com, check **Connected apps**, **Groundwork**, **Permissions**. |
| Groundwork does not appear in Rovo Studio tools | Re-run `forge deploy` and `forge install --upgrade`, then reload Rovo. |
| `forge tunnel` fails | Its helper download was skipped at install time. Deploy instead, or reinstall the CLI with `npm install -g @forge/cli --allow-scripts=cloudflared`. |

## License

MIT. See `LICENSE`.
