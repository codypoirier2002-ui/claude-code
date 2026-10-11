---
station: memory
file: goals
read_by: [commander, writer, reviewer]
read_when: start of every task
---

# Goals

Commander reads this file at the start of every task, and Writer and Reviewer
get it with their stage input. Keep it short: the whole file goes into prompts
(it is cut off at 4,000 characters).

- Produce accurate, well-sourced research reports that a busy reader can act on.
- Prefer primary sources (official docs, papers, project READMEs, package
  metadata) over commentary.
- Say plainly when evidence is thin, missing, or conflicting.
- Keep reports short enough to read in five minutes.
