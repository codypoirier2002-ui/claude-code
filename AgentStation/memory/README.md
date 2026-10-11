# Station memory

Plain Markdown, so this folder also works as an Obsidian vault (open
`AgentStation/memory` as a vault). Obsidian is optional.

A folder does not remember anything on its own. The station server reads and
writes these files at fixed points (`server/src/memory.ts`):

| When | What the station does |
| --- | --- |
| Task start (Plan stage) | Loads `goals.md`, `rules.md`, the newest 15 entries of `decisions.md`, and `projects/<project>.md` if the task names a project. Commander receives all of it. |
| Every later stage | Researcher gets `rules.md`; Writer gets `goals.md`, `rules.md`, and the project note; Reviewer gets `goals.md` and `rules.md`. |
| Task approved and completed | Appends a summary line to `daily/YYYY-MM-DD.md`, appends a dated section to `projects/<project>.md` if set, and appends the decisions you chose to keep to `decisions.md`. |
| Task failed or cancelled | Appends a one-line record with the error to `daily/YYYY-MM-DD.md`. |

Each stage records a SHA-256 of the memory it was given, so you can tell which
version of your rules a report was written under.

Agents never write here directly: they have no file tools. Anything an agent
proposes for memory goes through the approval panel first.

Do not put API keys or other secrets in these files. They are injected into
prompts.
