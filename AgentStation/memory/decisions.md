---
station: memory
file: decisions
read_by: [commander]
read_when: start of every task (newest 15 entries)
written_when: a task is approved and its proposed decisions are kept
---

# Decisions

Durable decisions the station should remember. Commander reads the newest 15
entries at the start of each task. The station appends entries only when a
human approves a task; agent-proposed entries are labelled with their task ID.

Format: `- YYYY-MM-DD — decision (source)`

- 2026-10-09 — Agents run on the Claude subscription through OpenClaw's
  `claude-cli` route. That route reports tokens, not dollars, so the daily
  limit is enforced as a token cap. (setup)
- 2026-10-09 — Agents get no tools. The station fetches approved sources,
  writes files, and runs external actions only after approval. (setup)
- 2026-10-09 — When package metadata (Requires-Python, licence, latest release) was not fetched, report it as not found in the fetched sources; do not fill it from README prose or memory. (T-0002, approved by operator)
