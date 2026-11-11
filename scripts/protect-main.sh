#!/usr/bin/env bash
# Branch protection for `main`, as a GitHub *ruleset*.
#
# Rulesets rather than the older "branch protection rules" for one reason that
# matters here: a classic rule exempts repository admins by default, so on a
# single-owner repo it protects `main` from everyone except the only person who
# pushes to it. A ruleset has an explicit, empty bypass list — nobody is exempt
# until somebody is named — so "cannot force-push or delete main" means it.
#
# There is no committed-file form of this: branch protection lives in GitHub's
# API, not in the repository, so it has to be applied once per repo. That is what
# this script is for. It is idempotent — re-running updates the ruleset in place
# rather than creating a second one.
#
# Usage:
#   GH_TOKEN=ghp_…  bash scripts/protect-main.sh [--require-ci] [--require-pr] [--dry-run]
#
# The token needs `administration:write` on the repo (a classic PAT with `repo`,
# or a fine-grained PAT with Repository administration: read and write).
#
#   (default)      block force-pushes and deletion of `main`. Nothing else.
#   --require-ci   also require the CI jobs to pass. NOTE: this applies to direct
#                  pushes too, so a `git push origin main` whose checks have not
#                  run yet is refused. Sensible once everything lands via PR.
#   --require-pr   also require a pull request. This ends direct pushes to `main`
#                  entirely, including a fast-forward merge from `dev` done
#                  locally — use the GitHub merge button (or `gh pr merge`) after
#                  turning it on.
set -euo pipefail

OWNER="${OWNER:-maxharris1}"
REPO="${REPO:-Cleffy}"
BRANCH="${BRANCH:-main}"
RULESET_NAME="protect-${BRANCH}"

require_ci=false
require_pr=false
dry_run=false
for arg in "$@"; do
    case "$arg" in
        --require-ci) require_ci=true ;;
        --require-pr) require_pr=true ;;
        --dry-run) dry_run=true ;;
        *) echo "unknown flag: $arg" >&2; exit 2 ;;
    esac
done

if [[ -z "${GH_TOKEN:-}" ]]; then
    echo "protect-main: GH_TOKEN is not set (needs administration:write on ${OWNER}/${REPO})" >&2
    exit 2
fi

api() {
    # Content-Type matters: `curl -d` defaults to form encoding, and the ruleset
    # endpoint takes JSON only. Without this the POST is rejected for a reason
    # that has nothing to do with the payload being wrong.
    curl -sS --fail-with-body \
        -H "Authorization: Bearer ${GH_TOKEN}" \
        -H "Accept: application/vnd.github+json" \
        -H "Content-Type: application/json" \
        -H "X-GitHub-Api-Version: 2022-11-28" \
        "$@"
}

# `deletion` blocks deleting the branch; `non_fast_forward` blocks force-pushes.
# Those two ARE the request; everything below them is opt-in.
rules='[{"type":"deletion"},{"type":"non_fast_forward"}]'

if [[ "$require_ci" == true ]]; then
    # `strict_required_status_checks_policy: false` — do not also demand the
    # branch be up to date with main before merging. On a two-branch repo that
    # setting mostly produces re-run churn.
    rules=$(printf '%s' "$rules" | python3 -c '
import json,sys
rules=json.load(sys.stdin)
rules.append({
  "type":"required_status_checks",
  "parameters":{
    "strict_required_status_checks_policy": False,
    "required_status_checks":[
      {"context":"checks"},
      {"context":"omr-service"},
      {"context":"supabase-drift"},
    ],
  },
})
json.dump(rules,sys.stdout)')
fi

if [[ "$require_pr" == true ]]; then
    rules=$(printf '%s' "$rules" | python3 -c '
import json,sys
rules=json.load(sys.stdin)
rules.append({
  "type":"pull_request",
  "parameters":{
    # 0 approvals: a solo repo cannot self-approve, and a rule that cannot be
    # satisfied is a rule that gets bypassed. Raise it when there is a reviewer.
    "required_approving_review_count": 0,
    "dismiss_stale_reviews_on_push": True,
    "require_code_owner_review": False,
    "require_last_push_approval": False,
    "required_review_thread_resolution": False,
  },
})
json.dump(rules,sys.stdout)')
fi

payload=$(python3 - "$RULESET_NAME" "$BRANCH" "$rules" <<'PY'
import json, sys
name, branch, rules = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
print(json.dumps({
    "name": name,
    "target": "branch",
    "enforcement": "active",
    # Empty: nobody bypasses, admins included. This is the whole point.
    "bypass_actors": [],
    "conditions": {"ref_name": {"include": [f"refs/heads/{branch}"], "exclude": []}},
    "rules": rules,
}, indent=2))
PY
)

echo "ruleset payload for ${OWNER}/${REPO}:"
echo "$payload"

if [[ "$dry_run" == true ]]; then
    echo
    echo "--dry-run: nothing sent."
    exit 0
fi

# Update in place if a ruleset of this name already exists, so re-running is safe.
existing=$(api "https://api.github.com/repos/${OWNER}/${REPO}/rulesets" \
    | python3 -c 'import json,sys
name = sys.argv[1]
for rs in json.load(sys.stdin):
    if rs.get("name") == name:
        print(rs["id"])
        break' "$RULESET_NAME" || true)

if [[ -n "${existing:-}" ]]; then
    echo
    echo "updating existing ruleset ${existing}…"
    api -X PUT -d "$payload" \
        "https://api.github.com/repos/${OWNER}/${REPO}/rulesets/${existing}" >/dev/null
else
    echo
    echo "creating ruleset…"
    api -X POST -d "$payload" \
        "https://api.github.com/repos/${OWNER}/${REPO}/rulesets" >/dev/null
fi

echo "done. Active rules on ${BRANCH}:"
api "https://api.github.com/repos/${OWNER}/${REPO}/rules/branches/${BRANCH}" \
    | python3 -c "import json,sys; [print('  -', r['type']) for r in json.load(sys.stdin)]"
