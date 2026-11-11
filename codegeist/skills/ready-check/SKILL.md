---
name: ready-check
description: Run a definition-of-ready review on a Jira work item. Use when someone asks whether a work item is ready to start, what it is missing before development, or how to prepare it for a teammate or an AI coding agent.
compatibility: Jira Cloud with the Groundwork Forge app installed.
allowed-tools: check-issue-readiness get-context-pack
license: MIT
metadata:
  app: Groundwork
  version: "1.0"
---

# Ready check

Use this playbook when the user wants to know whether a work item can be started, or wants it
prepared for a hand-off to a teammate or an AI coding agent.

## Steps

1. Call `check-issue-readiness`. Pass `issueKey` when the user names a work item, for example
   `KAN-12`. Leave it empty to use the work item the user is viewing.
2. If the result has an `error` field, explain it in one sentence and stop.
3. Report the verdict and score on one line, for example "🟡 Almost ready (72/100)".
4. Walk through `gaps` in the order given (the worst come first). For each gap, say what was found
   and give the fix. Then add the help below for that check:
   - **Done is defined** or **Success is defined**: offer to draft 3 to 5 acceptance criteria in
     "Given ..., when ..., then ..." form, based on the description. Mark assumptions with "(assumed)".
   - **Reproducible**: offer to draft numbered steps to reproduce, then "Expected:" and "Actual:"
     lines.
   - **No open blockers**: name each open blocker. Suggest splitting out the part that is not
     blocked.
   - **Purpose is clear**: ask which epic or goal this work serves.
   - **Reference material**: ask for the spec, design or Confluence page that explains the details.
   - **No open questions**: quote the question and suggest who could answer it, using `peopleToAsk`.
   - **No duplicate work**: name the open pull request and suggest talking to its author before
     starting.
   - **Clear title**, **Enough detail**, **Sized**: give the fix as written.
5. Name up to three people from `peopleToAsk`, each with the reason.
6. If the verdict is "Ready to start", or the user wants to hand the work item off anyway, call
   `get-context-pack` and return `contextPack` unchanged inside a code block.

## Reading the result

- `score` runs from 0 to 100. From 80, with no failed check, the item is ready to start. From 55,
  it is almost ready. Any open blocker makes the verdict "Blocked" whatever the score.
- `notChecked` lists checks that could not run, for example when the Teamwork Graph returned no
  data. Mention them only if the user asks why a check is missing.
- `teamworkGraph` says what the Teamwork Graph returned. Empty graph results can mean that nothing
  is linked yet or that the app was not granted its graph scopes. Never present them as an error.

## Boundaries

- Groundwork is read-only. Never claim to have edited the work item. Present drafts for the user to
  paste.
- Do not invent facts. Everything you state must come from the action results, or be marked as
  assumed.
