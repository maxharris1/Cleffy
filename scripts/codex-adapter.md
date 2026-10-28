<!-- Source for .claude/docs/harness/codex.md (our own text, not from pstack); scripts/vendor-pstack.sh copies it and appends "Not vendored here" -->
# pstack in Codex

pstack ships adapters for Cursor and Claude Code only. In Codex (CLI or Codex cloud), read this once per session before following a pstack skill. When a skill says "read the Claude Code adapter", read this file instead.

- Skills live in `.agents/skills/<name>/` (symlinks into `.claude/skills/<name>/`). Open a skill by reading its `SKILL.md`; pstack skills are marked explicit-only (`agents/openai.yaml`), so they run only when the prompt names them.
- The symlinks need Linux, macOS or WSL2. A native Windows checkout (`core.symlinks=false`) writes them as text files, so Codex finds no skills. That checkout is unsupported: if `.agents/skills/how/SKILL.md` does not resolve, stop and report it instead of going on without the skills.
- `Task` / subagent / "spawn N agents" steps: use Codex subagents if the session has them; otherwise run the steps yourself, one after another, and keep each step's output separate.
- Model slugs and reasoning levels in skills (`claude-*`, `gpt-*`, `composer-*`, `fast`, `high`): ignore. Use the session's model.
- Cursor-only features — Canvas, AskQuestion, Cursor rules (`.cursor/rules`, `pstack-models.mdc`), worktree tools, browser MCP, background/cloud agents: skip, and write one line "Skipped in Codex: <feature>".
- Codex cloud has no internet in the agent phase and no git remote: skip any step that fetches, pushes, opens PRs or reads GitHub; report it instead.
- Repo rules in AGENTS.md, including its Factory section, win over pstack when they conflict (no force-push, Max merges, review caps).
