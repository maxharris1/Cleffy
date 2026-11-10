# Cleffy: agent notes

Coding rules, commands and how to run the app are in `CLAUDE.md`. Factory settings are in `factory.md`. This file holds the pstack router.

### pstack (vendored, MIT — see .claude/vendor/pstack/)

pstack skills are vendored in `.claude/skills/` (shared by Cursor and Claude Code) and linked for Codex in `.agents/skills/`. They are explicit-only: use one when the task packet names it.

| Need                                       | Skill                                                                                                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| Default way of working on a ticket         | `poteto-mode` is not vendored here (held upstream, see `scripts/vendor-pstack.sh`); follow the task packet and the `principle-*` skills |
| Adversarial review of a plan or diff       | `interrogate`                                                                                                                           |
| What could this change break               | `blast-radius`                                                                                                                          |
| Build or refresh a repo verification skill | `create-verification-skill`, `maintain-verification-skill`                                                                              |
| Agents repeating mistakes                  | `correct`, `reflect`                                                                                                                    |
| Competing candidates / parallel work       | `arena`, `swarm` (Cursor or Claude Code only)                                                                                           |
| Design principles                          | `principle-*`                                                                                                                           |

Harness adapters: Claude Code reads `.claude/docs/harness/claude-code.md`; Codex reads `.claude/docs/harness/codex.md`. Rules in this file, including the Factory section, win over pstack.
Update: rerun `scripts/vendor-pstack.sh . <cursor/plugins SHA>`; never hand-edit files that contain `.pstack-vendored`.
