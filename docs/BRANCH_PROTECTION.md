# Protecting `main`, and keeping it honest about production

`main` is production: it builds cleffy.io, and Supabase's GitHub integration
applies its migrations and deploys its Edge Functions to
`jibgwgosihadbjgxdsfe`. Two different things follow from that, and they are
easy to confuse:

- **`main` must not be rewritten.** A force-push or a deletion destroys the
  history that production was built from. This is a GitHub setting.
- **`main` must not start lying.** A migration applied to production ahead of
  the branch that carries it leaves `main` describing a database that no longer
  exists. This is a CI check.

The first is the obvious one. The second is the one that actually happened.

## What happened, once

Migrations were applied to the production project before `dev` was merged into
`main`. Nothing was wrong with the migrations and nothing broke — but for two
days `main` carried 21 migrations while production ran 26, and the five extra
ones existed on `dev` alone. Anyone reading `main` to find out what production
was would have been wrong, and a `db push` from `main` would have been wrong
too.

It resolved when `dev` was merged. The point is that nothing would have said so
if it hadn't been.

## 1. Force-push and deletion protection

There is no committed-file form of this: branch protection lives in GitHub's
API rather than in the repository, so it is applied once, per repo.

```bash
GH_TOKEN=ghp_…  bash scripts/protect-main.sh
```

The token needs `administration:write` (a classic PAT with `repo`, or a
fine-grained PAT with _Repository administration: read and write_). Add
`--dry-run` to see the payload without sending it. Re-running updates the
ruleset in place.

This creates a **ruleset** rather than a classic branch-protection rule,
because a classic rule exempts repository admins by default — on a
single-owner repo that would protect `main` from everyone except the only
person who pushes to it. The ruleset's bypass list is empty, so it applies to
the owner too.

By hand instead: **Settings → Rules → Rulesets → New branch ruleset**, target
`refs/heads/main`, enforcement Active, tick **Restrict deletions** and **Block
force pushes**.

### The two opt-in flags

```bash
bash scripts/protect-main.sh --require-ci    # CI must pass
bash scripts/protect-main.sh --require-pr    # changes must arrive by PR
```

Both change how you work, so neither is on by default:

- `--require-ci` applies to **direct pushes as well as PRs**. A
  `git push origin main` whose checks have not run yet is refused.
- `--require-pr` ends direct pushes to `main` entirely — including a local
  fast-forward from `dev`. Merge through the GitHub button or `gh pr merge`
  after turning it on.

`--require-ci` is worth turning on now. `--require-pr` is worth it as soon as
there is anyone to review.

## 2. The drift check

`scripts/check-supabase-drift.mjs` asks the live project what it actually has
and compares it to the branch. It runs as the `supabase-drift` CI job, and
locally:

```bash
SUPABASE_ACCESS_TOKEN=sbp_… SUPABASE_PROJECT_REF=jibgwgosihadbjgxdsfe \
  npm run supabase:drift
```

It is read-only. It never applies a migration or deploys a function — Supabase's
integration does that on merge, and this only checks that the integration and
the branch still agree.

**It fails on:**

| Finding                               | Meaning                                                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `applied to the project, absent here` | A migration was run outside this branch. This is the incident above.                                         |
| `out of order`                        | A pending migration is older than the newest applied one; `db push` will refuse it.                          |
| `live but absent here`                | An Edge Function is deployed from no committed source — unreviewable, and lost with the laptop it came from. |

**It does not fail on** `pending` migrations or functions not yet live: that is
what a merge is _for_.

### One setup step

The job needs `SUPABASE_ACCESS_TOKEN` as a repository secret
(**Settings → Secrets and variables → Actions**) — the same `sbp_…` token used
locally. Until it is set the job emits a loud warning annotation and passes,
so that adding the guard does not redden every branch before the secret
exists. **A warning there means nothing is checking.**

Set `SUPABASE_PROJECT_REF` as a repository _variable_ to point the check at a
different project; it defaults to production.

### When the drift check fails

Do not "fix" it by deleting the migration from the project. Commit what
production already has:

1. Recover the SQL from the ledger — it is kept there:

    ```sql
    select version, name, array_to_string(statements, E';\n\n')
    from supabase_migrations.schema_migrations
    where version = '<version>';
    ```

2. Write it to `supabase/migrations/<version>_<name>.sql`, matching the version
   exactly. Because the version already appears in the ledger, `db push` treats
   it as applied and skips it — committing it is a no-op against production and
   restores the branch's ability to describe it.
3. If `statements` is null (some out-of-band paths record nothing),
   reconstruct from the live schema and say so in a comment in the file.

For a function that is live but uncommitted, fetch its source from the
dashboard, commit it, and let the next merge redeploy it.

## The habit that avoids all of this

Apply migrations by **merging**, not by hand. Push the branch, let the
integration apply it. If something has to be applied by hand — a hotfix, a
migration that needs supervision — commit the file in the same sitting, so the
window in which `main` is wrong is minutes rather than days.
