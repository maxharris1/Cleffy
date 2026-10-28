# Cleffy: agent notes

Coding rules, commands and how to run the app are in `CLAUDE.md`. This file holds the factory settings and the pstack router.

## Factory

```factory
base_branch: dev
branch_pattern: agent/{slug}
tracker: chat
local_suites: none
verify: off
stages: none
review: loop
review_skill: none
direct_push: none
envs: claude=env_01WAd3yiz3qpSnsofpyEwCh2
```

Notes for agents:

- Work comes from the Cleffy project bot's chat. The PR description is the record: what was asked, when and in which chat, the acceptance points, and what is out of scope.
- PRs target `dev` (`dev.cleffy.io`, Supabase branch `qdbnlrgylelelvwbkvnm`). `main` is production (`cleffy.io`); the Supabase GitHub integration deploys migrations on merge to `main`. Never push to `dev` or `main`; Max merges.
- Claude Code cloud env: `Cleffy` (`env_01WAd3yiz3qpSnsofpyEwCh2`). The SessionStart hook installs dependencies and starts Docker; `npm run cloud:up` boots local Supabase, Edge Functions and Vite on http://localhost:5173.
- Before pushing, run what CI's `checks` job runs: `npm run lint:check`, `npm run typecheck`, `npm run test`, `npm run build`. CI also runs `supabase-local` (local stack, SQL proofs), `omr-service`, `supabase-drift` and `edge-functions-deno`.
- UI changes: check them with the repo's `ui-check` skill (`scripts/ui/uifuzz.mjs`, desktop, iPad and phone viewports). Backend changes: read `supabase-ops` first.
- Risky areas: migrations, RLS and Edge Functions under `supabase/`, and billing (Stripe). Never apply migrations or change config on a hosted Supabase project from an agent session; CI runs the proofs on a local stack.

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
