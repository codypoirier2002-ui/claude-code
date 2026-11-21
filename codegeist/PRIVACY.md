# Groundwork privacy statement

Groundwork is a Forge app that runs entirely on Atlassian's platform.

- **What it reads.** When someone opens a Jira work item, asks the Groundwork agent, or calls one
  of its MCP tools, Groundwork reads the work item, its links, its remote links and its five most
  recent comments through the Jira REST API. It also reads the linked goals, pull requests,
  Confluence page owners and contributors, and teams through the Teamwork Graph API. Every read
  runs as the person who asked, so it returns only what that person can already see.
- **What it stores.** Nothing. Groundwork has no database, no key-value storage and no files.
  Each result is computed when it is asked for and then discarded.
- **What leaves Atlassian.** Nothing. Groundwork makes no calls outside Atlassian's platform, and
  its manifest declares no external hosts. When you connect an outside MCP client, Atlassian's MCP
  server sends that client the tool results you asked for, under the OAuth consent you gave.
- **What it changes.** Nothing. All of its Jira and Teamwork Graph permissions are read-only.
- **Logs.** Forge keeps the app's error logs. Groundwork logs only a short error message when a
  request fails, never work item content.
- **AI.** Groundwork does not call a language model itself. The Rovo agent and outside MCP clients
  use their own models, under their own terms.

Questions about this app can go to the app owner through the contact details on its Devpost
project page.
