# AgentStation artifact: handoff (2026-11-14)

## 1. What was built

**Feature:** AgentStation is a single-file claude.ai Artifact whose agents
run in the owner's tab. It now writes paste-ready content (scripts, posts,
ads, emails) and learns from the owner's reasons for rejecting drafts.

Artifacts:
- `AgentStation/claude-artifact/agentstation.html`: the whole app (engine,
  prompts, UI, Demo Mode).
- `AgentStation/claude-artifact/PORT-NOTES.md`: the findings, the fixes, and
  how each fix was checked. Read the newest sections first.
- `AgentStation/claude-artifact/BRIEF.md`: hard rules 1–8 (owner-only;
  nothing leaves the page; honesty; agents run only while the page is open).
- `AgentStation/claude-artifact/SPEC.md`: the porting spec of the original
  app.

Where each piece is:

| Piece | Branch / PR | State |
|---|---|---|
| Second-pass fixes plus auto-content | PR #18 | merged to `main` |
| Content route | `claude/agentstation-content-route`, PR #19 (base `main`) | open, not reviewed |
| Rejection reasons plus Feedback log | `claude/agentstation-rejection-feedback`, PR #20 (base #19's branch) | open, not reviewed |
| Live page | https://claude.ai/artifact/L6WRBp81kTiuP26jbv4M8E | version 8 = PR #20's code |

The live page runs code that `main` does not have yet.

## 2. How to run it

There is no build step. The file is the page.

- **Live:** open the URL above, signed in as the owner, then press
  **Start agents**. That press spends the owner's Claude plan, so only the
  owner presses it.
- **Free:** open the page and switch on **Demo Mode**. Demo Mode uses an
  in-memory store and canned agents, with no `sample()` calls.
- **Republish** with the Artifact tool:
  - Pass the same `url` and omit `capabilities` and `contract`, so the stored
    ones carry forward. The stored contract is 0.2.75.
  - A session that has not published the page must first `read` the live
    version in full, or the publish is refused.

## 3. What was tested

Test summary:
- Playwright, 23 tests against a fake `claude.use()` runtime: all pass. One
  Demo test is flaky under load and passes when run alone.
- Real-prompt check: content prompts for TikTok, Instagram and email were
  answered by fresh models and fed back through the station's checks. All
  three were paste-ready and none was flagged falsely. The TikTok came to
  about 30 s.

Test locations:
- The tests are not in the repo. They live in the session scratchpad, which
  is temporary:
  `C:\Users\codyp\AppData\Local\Temp\claude\a5da81de4aa5be9d\62b4ca88-8646-4a2e-b574-b7ace82304cd\scratchpad\pw\`
- Files there:
  - `test.mjs`: the 23 tests (engine, leases, limits, content route,
    feedback);
  - `fake-runtime.js`: the fake db and sample;
  - `checkdrafts.mjs`, `drafts/`, `prompts/`: the real-draft check.

To run the tests:
```bash
cd /c/Users/codyp/AppData/Local/Temp/claude/a5da81de4aa5be9d/62b4ca88-8646-4a2e-b574-b7ace82304cd/scratchpad/pw && node test.mjs /c/Users/codyp/Code/claude-code/AgentStation/claude-artifact/agentstation.html
```
The tests need `playwright-core` 1.65.1, which is in that folder's
`node_modules`. To run some tests only, add their names after the path,
comma-separated. The tests also need Chromium at
`%LOCALAPPDATA%\ms-playwright\chromium-1254\chrome-win64\chrome.exe`. A full
run takes several minutes, so run it in the background.

Known gaps:
- No real `sample()` run has happened on the live page. Only the owner can do
  that.
- CodeRabbit has not reviewed #19 or #20. #20 was skipped because its base is
  not the default branch.
- The test harness is lost once the scratchpad is cleaned.

## 4. Deployment checklist

Before the merge:
- [ ] Owner ticks "Trigger review" on PR #19. CodeRabbit needs this because
      the repo has fewer than 10 stars.
- [ ] Fix each CodeRabbit finding on #19, or reply on its thread saying why
      not.
- [ ] Owner merges #19. GitHub then moves #20 onto `main` by itself.
- [ ] Trigger review on #20, fix its findings, and the owner merges it.

Live check (owner only):
- [ ] Open the live page and press Start agents.
- [ ] Queue one Content task, for example a TikTok with no facts. Expect:
  - it goes plan → draft → review → approval;
  - the approval card shows scores and a preview;
  - "Copy content" copies only the post.
- [ ] Reject it with a reason. Expect a line in Memory → Feedback log, and
      expect the next content task's draft to take that reason into account.
- [ ] Approve one. Expect an "Approved" line in the Feedback log.

Rollback:
- **Page:** republish the previous version's HTML to the same URL. Version 6
  has the second-pass fixes; version 7 has the content route. Or check out
  `main` or #19's branch and publish `AgentStation/claude-artifact/agentstation.html`. About 5 minutes.
- **Code:** close #20, or revert its commit `82658bd`, or revert #19's commit
  `eea418b`. Each PR is one commit.
- **Data:** the database survives a rollback. Old pages ignore the new
  `verdict` field and the `memory/feedback` document.

## 5. Known issues and next steps

✅ Completed:
- All second-pass findings from `AgentStation/claude-artifact/PORT-NOTES.md` are checked and fixed (#18).
- The content route:
  - formats: TikTok, Shorts, YouTube, Instagram, Facebook ad, email,
    Pinterest, blog, other;
  - length and fill-in checks;
  - a review scored on hook, clarity, platform fit, CTA and originality
    (any score below 3 means a revision);
  - output in two parts: "Ready to post" and "Before you post".
- Rejecting a draft needs one of eight reasons. Each verdict is saved on its
  task and appended to `memory/feedback`, and the agents read the newest 20
  lines.
- Auto-content stops choosing a format for a while if its last 5 verdicts
  include 3 or more rejections and no approval.

⚠️ Known limitations:
- Agents run only while the owner's tab is open (BRIEF rule 8).
- Spoken length is estimated at 2.5 words per second and may be off for fast
  or slow voices.
- Only the owner's own decisions count as verdicts. Automatic approvals by
  the station are not logged.
- `AGENTS.md` and `.agents/` in the repo root are untracked and were not
  touched. `AGENTS.md` looks like a broken find-and-replace copy of
  `CLAUDE.md`.

📋 Next steps, in priority order:
1. Get #19 and then #20 reviewed and merged (owner, plus fixes; about 1 h).
2. Do the live check above (owner; about 15 min).
3. Move the Playwright harness into the repo, for example under
   `AgentStation/claude-artifact/tests/`, so the 23 tests outlive this
   session. Its own PR; about 1 h.

⚡ Quick wins:
- Add a per-format approval rate to the Feedback log view.
- Let the owner tune `WORDS_PER_SECOND` in settings.
