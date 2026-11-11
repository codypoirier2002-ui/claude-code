# Owner steps: from this folder to a Codegeist 2026 submission

Claude built Groundwork and checked everything that can be checked without your Atlassian login.
The steps below need **you**: your accounts, your API token, your clicks on terms, and your approval.
Claude never creates accounts, types tokens or passwords, accepts terms, publishes, pushes or
submits.

**Deadline:** Tuesday, December 22, 2026, 12:00 pm Pacific (3:00 pm Atlantic). Aim to submit by
**December 18**, to leave time for problems.

## 0. Check that you are eligible (5 minutes)

- The rules require you to be at least the **age of majority where you live** when you enter.
  In Canada it is **18** in Alberta, Manitoba, Ontario, Prince Edward Island and Saskatchewan, and
  **19** in British Columbia, New Brunswick, Newfoundland and Labrador, Nova Scotia, the Northwest
  Territories, Nunavut and Yukon. If you are 18 and live in a "19" province, wait until your 19th
  birthday before entering. Quebec residents are excluded.
- **Ownership:** the rules say the entry must be "the original work of the Entrant" and
  "solely owned by the Entrant". Outside technical help is allowed only if the result is the
  entrant's own work and ideas. Claude Code chose the idea and wrote the code and documents for
  you, and the submission text says so. Read section 4 of the rules
  (https://codegeist2026.devpost.com/rules) and decide whether you are comfortable entering on that
  basis. Shaping the idea yourself (the checks, the wording, the demo) makes the entry more yours.
- **License:** `LICENSE` is MIT, with you (`codypoirier2002-ui`) as the copyright holder. Keep it or
  change it before you publish.

## 1. Create a free Atlassian account (you, 5 minutes)

Skip this if you already have one. Go to https://id.atlassian.com/signup and sign up with your own
email. Read and accept the terms yourself. It is free, with no payment method.

## 2. Open a terminal with Node 24 (you, 1 minute)

Open **PowerShell** and paste these lines. Repeat the first line in every new window.

```powershell
$env:Path = "$env:APPDATA\fnm\node-versions\v24.22.3\installation;" + $env:Path
cd C:\Users\codyp\Code\claude-code\.claude\worktrees\codegeist-2026-17e000\codegeist
node --version     # should print v24.22.3
forge --version    # should print 15.1.0 or later
```

Claude ran these lines on this machine. `forge --version` printed `15.1.0` after 30 seconds to
2.5 minutes, depending on the connection. Every `forge` command has that start-up delay, so give it
time. Without the first line, `forge`
either isn't found or runs under Node 26, which the Forge CLI does not support.

**If that folder is gone.** The work lives on the git branch `claude/codegeist-2026-17e000` in
`C:\Users\codyp\Code\claude-code`; the folder above is only a working copy of it. To get it back:

```powershell
cd C:\Users\codyp\Code\claude-code
git worktree prune
git worktree add ..\groundwork claude/codegeist-2026-17e000
cd ..\groundwork\codegeist
npm ci
```

## 3. Create an API token and log in (you, 5 minutes)

1. Go to https://id.atlassian.com/manage-profile/security/api-tokens.
2. Select **Create API token with scopes**. Name it `codegeist26`, pick an expiry after
   March 2027, choose **Forge** as the app, and keep the default scopes.
3. Copy the token. **Do not paste it into Claude or any chat.**
4. In your PowerShell window, run `forge login` and enter your email and the token.
   - If it asks to "collect CLI usage and error reporting information", either answer is fine.
     **No** keeps the most private.

## 4. Get the free demo site (you, 10 minutes, mostly waiting)

```powershell
forge site provision
```

This creates a free, pre-configured site with Jira, Confluence, Jira Service Management and Rovo,
seeded with demo data. It lasts 90 days, which takes it to about February 2027 and covers the
demo video. Write down the site URL it prints. Open it and check that Jira, Confluence (at `/wiki`)
and Rovo Chat load.

## 5. Register the app under your account (you, 2 minutes)

```powershell
forge register
```

Name it **Groundwork**. This swaps the placeholder app ID in `manifest.yml` for your own. If the
CLI shows developer terms or asks you to create a developer space, read the terms and answer
yourself. Afterwards, `manifest.yml` has changed: tell Claude "yes, commit the app ID" (or commit it
yourself), so the branch keeps your real app ID.

**Billing safety:** never add a payment method in the developer console. With no payment method,
Atlassian cannot charge you anything. Groundwork's expected use is a tiny fraction of the free
monthly allowance. In the worst case, usage above the allowance would pause the app after a 14-day
notice; it would not create a bill.

## 6. Deploy and install: say "yes" to Claude, or run it yourself (10 minutes)

Tell Claude **"yes, deploy and install Groundwork"** in this session and it will run:

```powershell
npm ci
npm run check
forge lint
forge deploy
forge install --demo-site      # choose Jira
```

Or run those lines yourself. On the install screen, approve the scopes. Groundwork reads Jira and
the Teamwork Graph and never writes.

## 7. Verify on your site (you, 15 minutes)

Tick each of these. If one fails, paste the message to Claude; never paste your token.

- [ ] Open any work item. On the right, under the fields, expand **Ready check**. You should see a
      score, a verdict and the checklist.
- [ ] Edit that work item's description. The panel should re-check by itself within a few seconds.
- [ ] Select **View context pack**. A Markdown brief should open.
- [ ] Open Rovo Chat, pick the **Groundwork** agent, and ask "Is this work item ready to start?" on a
      work item. Then ask "Which work items in this project are ready to start?"
- [ ] In Rovo, choose **Create agent**, then **Tools**, **Add tools**, **Connected apps**, and
      **Groundwork**. The three tools should be listed. Add them, publish the agent, and try it.
- [ ] Check the panel footer. If it says "no linked goals, pull requests, page owners or teams", open
      admin.atlassian.com, go to **Apps**, **Sites**, your site, **Connected apps**, **Groundwork**,
      **Permissions**, and make sure the graph scopes are on. Then link a Confluence page to a work
      item and re-check.
- [ ] Optional: try the graph queries yourself in the Teamwork Graph Query Builder at
      https://teamwork-graph.atlassian.com/query-builder (pick your site). The five queries are in
      `src/core/graph.ts`: `jiraWorkItemGoals`, `jiraWorkItemLinkedExternalPullRequests`,
      `confluencePageOwners`, `confluencePageContributors` and `atlassianTeamsBySpace`. If one
      reports an unknown field, tell Claude which one and what the error says.

## 8. Prepare demo data (you or Rovo, 20 minutes)

`SUBMISSION.md` lists four work items, one Confluence page and one goal to create, with text you can
paste. They make every verdict appear on camera.

## 9. Production deploy and installation link (you, 15 minutes)

1. Tell Claude "yes, deploy to production", or run:
   ```powershell
   forge deploy -e production
   forge install -e production --demo-site
   ```
2. Open https://developer.atlassian.com/console/myapps and choose **Groundwork**. Select
   **Distribution**, then **Edit**, then **Sharing**.
3. Fill in the app details. For privacy and security questions, `PRIVACY.md` has the answers:
   Groundwork stores no data, sends nothing outside Atlassian, and is read-only. If a privacy policy
   URL is required, push this branch first (step 12) and use the GitHub link to `PRIVACY.md`.
4. Choose **Jira** as the Atlassian app, save, and copy the **installation link**. Judges use it.
5. Keep the production deployment up until the winners are announced, around
   February 15, 2027.

## 10. Record the demo video (you, 1 to 2 hours)

- Follow the shot list in `SUBMISSION.md`. Keep it under 5 minutes; about 3:30 is ideal.
- Use your own voice or on-screen captions. Use **no copyrighted music**.
- Show only Atlassian products and Groundwork. The rules forbid other companies' trademarks unless
  you have permission, so do not show other AI tools' logos or interfaces.
- Upload to YouTube with visibility set to **Public**. Unlisted does not count.

## 11. Register on Devpost (you, 5 minutes)

Go to https://codegeist2026.devpost.com, select **Join hackathon**, and sign up or log in. Read and
accept Devpost's terms yourself.

## 12. Optional: publish the code (you approve, Claude pushes)

The repository is a public fork, so pushing this branch makes the code public. Devpost does not
require a repository link, but one helps judges. Tell Claude "yes, push the codegeist branch" if you
want that. Claude will not push without that message.

## 13. Fill in the submission, then approve it (you)

Copy from `SUBMISSION.md`: the title, tagline, story, built-with tags, testing instructions,
category (**Apps for Software Teams**) and bonus write-ups. Add the YouTube URL and the installation
link. Pick the bonus prizes: **Best Agents** and **Best app with Atlassian MCP**, plus **Best Teamwork
Graph integration** if step 7 showed graph data. One entry can win at most one bonus prize.
Read it all once more, then select **Submit** yourself before December 22, 12:00 pm Pacific.

## What Claude verified locally

- `npm run check` passes: ESLint, TypeScript (6.0, and also the Forge CLI's bundled 5.9), 108 unit
  tests, and an esbuild bundle of both entry points.
- `manifest.yml` passes the Forge CLI's own full manifest validator (`@forge/manifest` 13.9.0),
  which runs offline as part of the tests. Its schema covers `rovo:agent` (including `skills`),
  `rovo:skill`, `rovo:mcp`, `action` and the UI Kit `jira:issueContext`. It does not read the
  `SKILL.md` files; a separate unit test checks those against the documented format.
- The PowerShell lines in step 2 run on this machine: Node 24.22.3, and `forge --version` printed
  15.1.0.

## What Claude could not verify without your login

- `forge lint`, `forge register`, `forge deploy` and `forge install`, because each needs your login.
  `forge lint` adds Forge's code rules on top of the manifest validator that already passed.
- That the panel, the agent, the skill and the MCP tools render and run on a real site.
- That the five Teamwork Graph queries match the live schema and return data on the demo site.
- The distribution form, the installation link and the judges' install flow.
- What the seeded demo data looks like.
- That Rovo agents, Rovo Studio, `rovo:mcp` tools and the Teamwork Graph all work on the free demo
  site at no cost. This comes from Atlassian's documentation (2026-11-11): the Codegeist resources
  page says the demo site includes Rovo Enterprise and Studio, the Rovo MCP tutorial needs only
  Rovo activated, and the Forge pricing page says a developer is never charged for Rovo credits.
  None of it has been tested on a real site yet.
