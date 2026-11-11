#!/usr/bin/env bash
# Vendor pstack (MIT, Lauren Tan) into ANY repo checkout so Claude Code cloud
# (.claude/skills) and Codex cloud (.agents/skills) load it from the fresh clone.
# Usage: vendor-pstack.sh <repo-root> [cursor/plugins commit or ref]
# Home: pstack-factory/ in the shared skill library; the setup PR copies it to scripts/.
# Version bump = rerun with a new SHA, one PR per repo. Tests: scripts/test-vendor-pstack.sh (offline fixture).
# Prepared 2026-10-27 by Grok Bot. AUT-2166: removes dropped skills, checks ownership of every destination,
# records the resolved commit, and writes local fallbacks where a vendored file names a skill left out here.
# Order: check every input and destination, build every file in a temp folder, then install. One run per
# checkout at a time (a lock in the git dir). Ownership is recorded before new files appear, so an interrupted
# run can be rerun, and a failed run puts back any skill folder it had moved aside. It deletes only what it can
# prove it wrote (a skill folder only when MANIFEST records it and its marker checks out); anything else is kept,
# with a warning.
# Runs on Linux, macOS (including its /bin/bash 3.2) and WSL2; native Windows checkouts are unsupported (symlinks).
# PSTACK_UPSTREAM overrides the upstream URL (the test harness points it at a local fixture repo).
# shellcheck disable=SC2016  # backticks in single quotes are Markdown, not command substitution
set -euo pipefail
die() { echo "vendor-pstack: $*" >&2; exit 1; }
warn() { echo "vendor-pstack: warning: $*" >&2; }
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ARG="${1:?usage: vendor-pstack.sh <repo-root> [ref]}"
REF="${2:-519d36aa98955bf680db01bcde5fdfba686dc901}"   # cursor/plugins main, 2026-10-27 01:52 ET, pstack 0.15.34
UPSTREAM="${PSTACK_UPSTREAM:-https://github.com/cursor/plugins}"
# Skills left out. statechart, setup-pstack, make-bot-ui, ketchup-video, automate-me: Cursor-only or out of
# scope. create-formal-verification-skill: needs statechart. poteto-mode: held until upstream fixes watch-pr
# readiness, worktree cleanup and the store lock race (AUT-2166).
EXCLUDE=(statechart setup-pstack make-bot-ui ketchup-video automate-me create-formal-verification-skill poteto-mode)
EXCLUDE_AGENTS=(poteto-agent)   # serves poteto-mode only
VERBATIM=(poteto-help)          # copied unchanged, even where it names a skill left out (Max, AUT-2166)
# Playbooks that live inside a skill left out, as name|skill|fallback. A vendored file that names one gets the
# fallback in its note, since the name alone doesn't match the skill's.
PLAYBOOKS=(
  'session-pickup|poteto-mode|to resume one specific prior chat, read that chat'"'"'s transcript directly, or run `recall` scoped to that one chat'
  'Opening a PR|poteto-mode|follow the PR rules in this repo'"'"'s `AGENTS.md`'
  'Perf issue|poteto-mode|work from `benchmark-checklist` and the matching `principle-*` skills, such as `principle-explain-the-number`'
  'Hillclimb|poteto-mode|vet and freeze the harness with `benchmark-checklist`, then keep or revert each change by its numbers'
)
# Paths outside marked skills that the pre-manifest version of this script wrote. Without skill records (that
# version, or a MANIFEST with the old header), the only marked folders it deletes are ones named in EXCLUDE.
LEGACY_OWNED=(.claude/agents/poteto-agent.md .claude/agents/comment-sicko.md .claude/docs/harness/claude-code.md
  .claude/docs/harness/codex.md .claude/vendor/pstack/LICENSE .claude/vendor/pstack/README.md .claude/vendor/pstack/SOURCE_SHA)
VDIR=.claude/vendor/pstack
MANIFEST=$VDIR/MANIFEST
MANIFEST_HEADER='# Written by scripts/vendor-pstack.sh: the files it owns, and as skill:<name> the skill folders it vendored'
OLD_MANIFEST_HEADER='# Written by scripts/vendor-pstack.sh: paths it owns besides skills marked .pstack-vendored'  # no skill records
# Every folder it writes into, parents first. None may be a symlink, so no write lands outside the checkout.
PARENTS=(.claude .claude/skills .claude/agents .claude/docs .claude/docs/harness .claude/vendor "$VDIR" .agents .agents/skills)
MARK_RE='^pstack [0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)? @ cursor/plugins [0-9a-f]{40}$'
VERSION_RE='^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'
NAME_RE='^[A-Za-z0-9][A-Za-z0-9._-]*$'
# The only paths a MANIFEST may own: agents, harness adapters and the vendor metadata.
OWNABLE_RE='^\.claude/(agents/[A-Za-z0-9][A-Za-z0-9._-]*\.md|docs/harness/[A-Za-z0-9][A-Za-z0-9._-]*\.md|vendor/pstack/(LICENSE|README\.md|SOURCE_SHA))$'

# Bash 3.2 (macOS) treats an empty array as unset under set -u, so every array expansion is guarded: ${a[@]+"${a[@]}"}.
has() { local x="$1"; shift; [[ " $* " == *" $x "* ]]; }

REPO="$(cd "$REPO_ARG" 2>/dev/null && pwd -P)" || die "no such directory: $REPO_ARG"
TOP="$(git -C "$REPO" rev-parse --show-toplevel 2>/dev/null)" || die "$REPO is not a git checkout"
[[ "$(cd "$TOP" && pwd -P)" == "$REPO" ]] || die "$REPO is not the root of its checkout ($TOP)"
GITDIR="$(git -C "$REPO" rev-parse --absolute-git-dir)"
ADAPTER="$HERE/codex-adapter.md"   # Codex adapter is our own text (pstack ships none)
[[ -f "$ADAPTER" && -r "$ADAPTER" ]] || die "no codex-adapter.md next to the script ($HERE)"
perl -MJSON::PP -e 1 2>/dev/null || die "needs perl with JSON::PP (core since perl 5.14)"

# One run per checkout: a lock folder in this checkout's git dir, held until the final MANIFEST is written.
LOCK="$GITDIR/vendor-pstack.lock"; LOCKED=0; TMP=""; STAGE=""
cleanup() {
  local rc=$? o n
  if [[ -n "$STAGE" ]]; then
    # A failed run puts back each skill folder it moved aside and did not replace, so none goes missing.
    if [[ "$rc" != 0 ]]; then
      for o in "$STAGE"/old/*; do
        n="${o##*/}"
        if [[ -d "$o" && ! -e "$REPO/.claude/skills/$n" && ! -L "$REPO/.claude/skills/$n" ]] &&
          mv "$o" "$REPO/.claude/skills/$n"; then
          if [[ ! -e "$REPO/.agents/skills/$n" && ! -L "$REPO/.agents/skills/$n" ]]; then
            ln -s "$(link_target "$n")" "$REPO/.agents/skills/$n" || true
          fi
          warn "put back the previous .claude/skills/$n"
        fi
      done
    fi
    rm -rf "$STAGE"
  fi
  if [[ -n "$TMP" ]]; then rm -rf "$TMP"; fi
  if [[ "$LOCKED" == 1 ]]; then rm -rf "$LOCK"; fi
}
link_target() { printf '../../.claude/skills/%s' "$1"; }
trap cleanup EXIT
# HUP/INT/TERM are held while the lock is taken, so there is never a lock without its pid file: the mkdir runs
# with them ignored, and one that arrives meanwhile is acted on once the pid is written.
SIG=""; trap 'SIG=129' HUP; trap 'SIG=130' INT; trap 'SIG=143' TERM
if (trap '' HUP INT TERM; mkdir "$LOCK") 2>/dev/null; then LOCKED=1; echo "$$" > "$LOCK/pid"; fi
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM
if [[ -n "$SIG" ]]; then exit "$SIG"; fi
if [[ "$LOCKED" != 1 ]]; then
  owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if ! [[ "$owner" =~ ^[0-9]+$ ]]; then
    die "lock $LOCK has no valid pid file, so it is possibly stale or initializing: confirm no vendor-pstack run is active, then remove $LOCK and rerun"
  elif ! kill -0 "$owner" 2>/dev/null && ! ps -p "$owner" >/dev/null 2>&1; then
    die "stale lock $LOCK: pid $owner is not running. Confirm no vendor-pstack run is active, then remove that folder and rerun"
  fi
  die "another vendor-pstack run holds the lock ($LOCK, pid $owner). If none is active (another process may have reused that pid), remove that folder and rerun"
fi

cd "$REPO"
for d in ${PARENTS[@]+"${PARENTS[@]}"}; do
  if [[ -L "$d" ]]; then die "$d is a symlink; refusing to write through it"
  elif [[ -e "$d" && ! -d "$d" ]]; then die "$d exists and is not a directory"; fi
done
for s in "$VDIR"/.staging.*; do
  if [[ -e "$s" ]]; then warn "$s is left from an interrupted run; delete it"; fi
done

TMP="$(mktemp -d "${TMPDIR:-/tmp}/vendor-pstack.XXXXXX")"
git clone -q --filter=blob:none --no-checkout "$UPSTREAM" "$TMP/cp" || die "could not clone $UPSTREAM"
git -C "$TMP/cp" sparse-checkout set --no-cone /harness/pstack/claude-code
git -C "$TMP/cp" checkout -q "$REF" || die "no such ref upstream: $REF"
SHA="$(git -C "$TMP/cp" rev-parse --verify 'HEAD^{commit}')"
[[ "$REF" == "$SHA" ]] || echo "vendor-pstack: $REF resolved to $SHA; recording $SHA" >&2
SRC="$TMP/cp/harness/pstack/claude-code"
UP="https://github.com/cursor/plugins/blob/$SHA/harness/pstack/claude-code"

[[ -f "$SRC/plugin.json" ]] || die "no harness/pstack/claude-code/plugin.json at $SHA"
VERSION="$(perl -MJSON::PP -0777 -ne '
  my $j = eval { decode_json($_) }; my $v = ref $j eq "HASH" ? $j->{version} : undef;
  print $v if defined $v && !ref $v' "$SRC/plugin.json")"
[[ "$VERSION" =~ $VERSION_RE ]] || die "plugin.json: missing or invalid top-level version '$VERSION'"
MARK="pstack $VERSION @ cursor/plugins $SHA"

WANT=(); for d in "$SRC"/skills/*/; do
  [[ -d "$d" ]] || continue; n="$(basename "$d")"
  [[ "$n" =~ $NAME_RE ]] || die "unexpected upstream skill name '$n'"
  has "$n" ${EXCLUDE[@]+"${EXCLUDE[@]}"} || WANT+=("$n")
done
AGENTS=(); for f in "$SRC"/agents/*.md; do
  [[ -f "$f" ]] || continue; a="$(basename "$f" .md)"
  [[ "$a" =~ $NAME_RE ]] || die "unexpected upstream agent name '$a'"
  has "$a" ${EXCLUDE_AGENTS[@]+"${EXCLUDE_AGENTS[@]}"} || AGENTS+=("$a")
done
((${#WANT[@]})) || die "no skills to vendor at $SHA"
OMIT=(${EXCLUDE[@]+"${EXCLUDE[@]}"} ${EXCLUDE_AGENTS[@]+"${EXCLUDE_AGENTS[@]}"})
PLAYS=""; for e in ${PLAYBOOKS[@]+"${PLAYBOOKS[@]}"}; do s="${e#*|}"; s="${s%%|*}"; if has "$s" ${OMIT[@]+"${OMIT[@]}"}; then PLAYS+="$e"$'\n'; fi; done
NEW_OWNED=(.claude/docs/harness/claude-code.md .claude/docs/harness/codex.md .claude/vendor/pstack/LICENSE
  .claude/vendor/pstack/README.md .claude/vendor/pstack/SOURCE_SHA)
for a in ${AGENTS[@]+"${AGENTS[@]}"}; do NEW_OWNED+=(".claude/agents/$a.md"); done
marker_ok() {  # Only a regular-file marker in this script's own format proves a skill folder is pstack.
  local m=".claude/skills/$1/.pstack-vendored"
  [[ -f "$m" && ! -L "$m" ]] && [[ "$(cat "$m")" =~ $MARK_RE ]]
}
vendored() { [[ -d ".claude/skills/$1" && ! -L ".claude/skills/$1" ]] && marker_ok "$1"; }
owned_ok() {  # A path this script may replace or delete: in its namespaces, and a regular file if present.
  case "$1" in
    '') die "$MANIFEST has an empty entry; refusing to trust it" ;;
    /*) die "$MANIFEST names absolute path $1; refusing to trust it" ;;
  esac
  case "/$1/" in */../*|*/./*) die "$MANIFEST names $1, which has a . or .. component; refusing to trust it" ;; esac
  [[ "$1" =~ $OWNABLE_RE ]] || die "$MANIFEST names $1, outside the paths this script writes; refusing to trust it"
  if [[ -L "$1" ]] || [[ -e "$1" && ! -f "$1" ]]; then die "$1 (owned per $MANIFEST) is not a regular file; refusing to touch it"; fi
}

# Preflight: read ownership and check every destination before changing anything.
OWNED=(); OWNED_SKILLS=()
if [[ -L "$MANIFEST" ]]; then die "COLLISION: $MANIFEST is a symlink"
elif [[ -e "$MANIFEST" && ! -f "$MANIFEST" ]]; then die "COLLISION: $MANIFEST exists and is not a regular file"
elif [[ -f "$MANIFEST" ]]; then
  h="$(head -n 1 "$MANIFEST")"
  [[ "$h" == "$MANIFEST_HEADER" || "$h" == "$OLD_MANIFEST_HEADER" ]] || die "COLLISION: $MANIFEST exists and this script did not write it"
  while IFS= read -r p || [[ -n "$p" ]]; do
    case "$p" in
      '#'*) continue ;;
      skill:*)
        [[ "${p#skill:}" =~ $NAME_RE ]] || die "$MANIFEST names $p, which is not a plain skill name; refusing to trust it"
        OWNED_SKILLS+=("${p#skill:}") ;;
      *) owned_ok "$p"; OWNED+=("$p") ;;
    esac
  done < "$MANIFEST"
elif [[ -f $VDIR/SOURCE_SHA && ! -L $VDIR/SOURCE_SHA ]]; then
  for p in ${LEGACY_OWNED[@]+"${LEGACY_OWNED[@]}"}; do owned_ok "$p"; OWNED+=("$p"); done
fi
# A skill folder is this script's when MANIFEST records it (or, with no skill records yet, when EXCLUDE names
# it) and its marker checks out. A copy, such as cp -R of a vendored skill, carries a valid marker but no record.
RECORDS=0; ((${#OWNED_SKILLS[@]})) && RECORDS=1
recorded() { if ((RECORDS)); then has "$1" ${OWNED_SKILLS[@]+"${OWNED_SKILLS[@]}"}; else has "$1" ${EXCLUDE[@]+"${EXCLUDE[@]}"}; fi; }
for n in ${WANT[@]+"${WANT[@]}"}; do
  if [[ -e ".claude/skills/$n" || -L ".claude/skills/$n" ]] && ! vendored "$n"; then
    die "COLLISION: .claude/skills/$n exists and is not pstack"
  elif vendored "$n" && ((RECORDS)) && ! recorded "$n"; then
    die "COLLISION: .claude/skills/$n is marked .pstack-vendored, but $MANIFEST does not record it as vendored here"
  fi
  l=".agents/skills/$n"
  if [[ -L "$l" ]]; then [[ "$(readlink "$l")" == "$(link_target "$n")" ]] || die "COLLISION: $l is a symlink to $(readlink "$l")"
  elif [[ -e "$l" ]]; then die "COLLISION: $l exists and is not a pstack symlink"; fi
done
for p in ${NEW_OWNED[@]+"${NEW_OWNED[@]}"}; do
  if [[ -L "$p" ]]; then die "COLLISION: $p is a symlink"
  elif [[ -e "$p" && ! -f "$p" ]]; then die "COLLISION: $p exists and is not a regular file"
  elif [[ -e "$p" ]] && ! has "$p" ${OWNED[@]+"${OWNED[@]}"}; then die "COLLISION: $p exists and this script did not write it"; fi
done

# What an earlier run vendored and this one does not (excluded here, or gone upstream). Skill folders count
# only when vendored() and recorded() both hold; symlinked folders, copies, and stray or foreign markers are kept.
RM_SKILLS=(); RM_LINKS=(); RM_FILES=()
for d in .claude/skills/*; do
  n="${d##*/}"
  if has "$n" ${WANT[@]+"${WANT[@]}"} || [[ -L "$d" || ! -d "$d" ]]; then continue; fi
  if vendored "$n" && recorded "$n"; then RM_SKILLS+=("$n")
  elif vendored "$n"; then
    warn "kept $d: it is marked .pstack-vendored, but $MANIFEST does not record it as vendored here (a copy?). Delete it by hand if it is not yours"
  elif [[ -e "$d/.pstack-vendored" || -L "$d/.pstack-vendored" ]]; then
    warn "kept $d: its .pstack-vendored marker is not one this script writes"
  fi
done
for l in .agents/skills/*; do
  n="${l##*/}"
  if [[ ! -L "$l" ]] || has "$n" ${WANT[@]+"${WANT[@]}"} || [[ "$(readlink "$l")" != "$(link_target "$n")" ]]; then continue; fi
  if [[ ! -e ".claude/skills/$n" && ! -L ".claude/skills/$n" ]] || has "$n" ${RM_SKILLS[@]+"${RM_SKILLS[@]}"}; then RM_LINKS+=("$l"); fi
done
for p in ${OWNED[@]+"${OWNED[@]}"}; do
  if ! has "$p" ${NEW_OWNED[@]+"${NEW_OWNED[@]}"} && [[ -f "$p" ]]; then RM_FILES+=("$p"); fi
done

# Build every file in $OUT, laid out like the checkout. Nothing in the checkout changes until all are built.
OUT="$TMP/out"
mkdir -p "$OUT/.claude/skills" "$OUT/.claude/agents" "$OUT/.claude/docs/harness" "$OUT/$VDIR"
note_files() {  # Prefix each .md that names a skill or playbook left out with a local fallback.
  OMIT="${OMIT[*]+${OMIT[*]}}" PLAYS="$PLAYS" perl -0777 -i -pe '
    BEGIN { @o = split " ", $ENV{OMIT}; @pb = map { [split /\|/, $_, 3] } grep { length } split /\n/, $ENV{PLAYS} }
    my $c = $_; my $named = sub { my $q = quotemeta $_[0]; $c =~ /(?<![\w-])$q(?![\w-])/ };
    my @hit = grep { $named->($_) } @o; my @play = grep { $named->($_->[0]) } @pb;
    for my $p (@play) { push @hit, $p->[1] unless grep { $_ eq $p->[1] } @hit }
    if (@hit) {
      my $names = join ", ", map { "`$_`" } @hit;
      my $note = "> **Not vendored here:** $names (left out by this repo'\''s `scripts/vendor-pstack.sh`). Where this file"
        . " sends you to one, skip that step with one line, `Skipped: <name> is not vendored here.`, and go on. If it is cited"
        . " for subagent model or effort choices, use the role'\''s default in this file, mapped by the harness adapter"
        . " (`.claude/docs/harness/`). If it is cited for principles, read the matching `principle-*` skills.";
      $note .= " Playbooks this file names from a skill left out here, and what to do instead: "
        . join("; ", map { "`$_->[0]` (in `$_->[1]`): $_->[2]" } @play) . "." if @play;
      $note .= "\n\n";
      s/\A(---\n.*?\n---\n\n?)/$1$note/s or s/\A/$note/;
    }' "$@"
}
for n in ${WANT[@]+"${WANT[@]}"}; do
  s="$OUT/.claude/skills/$n"; cp -R "$SRC/skills/$n" "$s"
  printf '%s\n' "$MARK" > "$s/.pstack-vendored"
  # Codex: honor pstack's disable-model-invocation as "explicit only"
  if [[ -f "$s/SKILL.md" ]] && grep -q '^disable-model-invocation: *true' "$s/SKILL.md"; then
    mkdir -p "$s/agents"; printf 'policy:\n  allow_implicit_invocation: false\n' > "$s/agents/openai.yaml"
  fi
  if ! has "$n" ${VERBATIM[@]+"${VERBATIM[@]}"}; then
    md=(); while IFS= read -r -d '' f; do md+=("$f"); done < <(find "$s" -name '*.md' -type f -print0)
    if ((${#md[@]})); then note_files ${md[@]+"${md[@]}"}; fi
  fi
done
for a in ${AGENTS[@]+"${AGENTS[@]}"}; do cp "$SRC/agents/$a.md" "$OUT/.claude/agents/$a.md"; done

NOT_HERE="$(printf '`%s`, ' ${EXCLUDE[@]+"${EXCLUDE[@]}"})"; NOT_HERE="${NOT_HERE%, }"
not_vendored_section() {
  printf '\n## Not vendored here\n\n'
  printf 'This repo leaves these pstack skills out: %s. The `%s` subagent type is not installed either. ' "$NOT_HERE" "${EXCLUDE_AGENTS[*]+${EXCLUDE_AGENTS[*]}}"
  printf 'When a skill names one, skip that step with one line, `Skipped: <name> is not vendored here.`, and go on. '
  printf "Model and effort choices that point at poteto-mode's Subagents section or a setup-pstack rule use the role's default slug, mapped as above.\n"
}

# Claude Code adapter: the agents and skills here are project-local, so drop the plugin's pstack: prefix.
CC="$OUT/.claude/docs/harness/claude-code.md"   # skills link ../../docs/harness/claude-code.md
cp "$SRC/docs/harness/claude-code.md" "$CC"
AGENT_LIST="$(printf '`%s`, ' ${AGENTS[@]+"${AGENTS[@]}"})"; AGENT_LIST="${AGENT_LIST%, }"
AGENT_LIST="$AGENT_LIST" perl -0777 -i -pe '
  sub once { my ($n) = @_; die "vendor-pstack: claude-code.md: expected 1 match for $_[1], got $n\n" unless $n == 1 }
  once(s/(`<pstack>` means the folder that holds `skills\/` and `docs\/`\.)/$1 Here that is `.claude\/`./g, "<pstack>");
  once(s/write `\/pstack:<name>`\./write `\/<name>`. This repo vendors pstack as project skills, so there is no `pstack:` prefix./g, "/pstack:<name>");
  once(s/^\| `poteto-agent`, `comment-sicko` \| `pstack:poteto-agent`, `pstack:comment-sicko` \|$/| $ENV{AGENT_LIST} | The same names: project agents in `.claude\/agents\/`, with no `pstack:` prefix. |/mg, "agent row");
  once(s/^## setup-pstack\n.*?(?=^## )//msg, "## setup-pstack");
  once(s/The plugin ships the skills, `docs\/guide\/`, and `README\.md`\./This repo vendors the skills, `docs\/harness\/` and the upstream README (`.claude\/vendor\/pstack\/README.md`), not `docs\/guide\/`./g, "plugin ships");
  die "vendor-pstack: claude-code.md still has a pstack: prefix\n" if /pstack:[\w<]/;
' "$CC"
not_vendored_section >> "$CC"
{ grep -v '^<!--' "$ADAPTER"; not_vendored_section; } > "$OUT/.claude/docs/harness/codex.md"

cp "$SRC/LICENSE" "$OUT/$VDIR/LICENSE"
# Upstream README: label it, and point its relative links at the vendored copy when there is one, else upstream.
{ printf '> **Upstream README**, copied from cursor/plugins `harness/pstack/claude-code/README.md` at `%s` (pstack %s).' "$SHA" "$VERSION"
  printf ' It describes installing the plugin. Here pstack is vendored instead: skills are in `.claude/skills/<name>/` (Codex: `.agents/skills/<name>/`),'
  printf ' you run them as `/<name>` with no `pstack:` prefix, and setup is the pstack section of `AGENTS.md`. Not vendored here: %s.' "$NOT_HERE"
  printf ' Links to files this repo does not vendor go to upstream.\n\n'
  UP="$UP" OUT="$OUT" perl -pe 's{\]\(\./([^)\s#]+)(#[^)\s]*)?\)}{ my ($p, $h) = ($1, $2 // ""); (-e "$ENV{OUT}/.claude/$p") ? "](../../$p$h)" : "]($ENV{UP}/$p$h)" }ge' "$SRC/README.md"
} > "$OUT/$VDIR/README.md"
echo "$SHA" > "$OUT/$VDIR/SOURCE_SHA"
skill_records() { printf 'skill:%s\n' "$@" | LC_ALL=C sort -u; }   # sorted, so MANIFEST doesn't depend on the locale
{ echo "$MANIFEST_HEADER"; printf '%s\n' ${NEW_OWNED[@]+"${NEW_OWNED[@]}"}; skill_records ${WANT[@]+"${WANT[@]}"}; } > "$OUT/$VDIR/MANIFEST"
# Written first: owns every path and skill folder old or new until the install finishes, so a rerun after a
# failure owns them too.
{ echo "$MANIFEST_HEADER"; printf '%s\n' ${NEW_OWNED[@]+"${NEW_OWNED[@]}"}
  for p in ${OWNED[@]+"${OWNED[@]}"}; do has "$p" ${NEW_OWNED[@]+"${NEW_OWNED[@]}"} || echo "$p"; done
  skill_records ${WANT[@]+"${WANT[@]}"} ${RM_SKILLS[@]+"${RM_SKILLS[@]}"}; } > "$TMP/MANIFEST.pending"

# Install. Staging sits beside the destinations (same filesystem), so each mv is a rename: a destination
# holds either the old complete file or folder or the new one (a skill folder is moved aside first, and a
# failed run's cleanup moves it back; after a kill -9 it stays in the warned staging folder). mv replaces a
# file without writing through it.
for d in ${PARENTS[@]+"${PARENTS[@]}"}; do [[ -d "$d" ]] || mkdir "$d"; done
STAGE="$(mktemp -d "$REPO/$VDIR/.staging.XXXXXX")"
cp -R "$OUT/.claude" "$STAGE/.claude"
cp "$TMP/MANIFEST.pending" "$STAGE/MANIFEST.pending"
mv -f "$STAGE/MANIFEST.pending" "$MANIFEST"
mkdir "$STAGE/old"
for n in ${WANT[@]+"${WANT[@]}"}; do
  if [[ -d ".claude/skills/$n" ]]; then mv ".claude/skills/$n" "$STAGE/old/$n"; fi
  mv "$STAGE/.claude/skills/$n" ".claude/skills/$n"
  # Codex discovery path: relative symlink into the shared source
  [[ -L ".agents/skills/$n" ]] || ln -s "$(link_target "$n")" ".agents/skills/$n"
done
REMOVED=()
for n in ${RM_SKILLS[@]+"${RM_SKILLS[@]}"}; do rm -rf ".claude/skills/$n"; REMOVED+=("$n"); done
for l in ${RM_LINKS[@]+"${RM_LINKS[@]}"}; do rm "$l"; done
for p in ${RM_FILES[@]+"${RM_FILES[@]}"}; do rm "$p"; REMOVED+=("$p"); done
for p in ${NEW_OWNED[@]+"${NEW_OWNED[@]}"}; do mv -f "$STAGE/$p" "$p"; done
mv -f "$STAGE/$MANIFEST" "$MANIFEST"

# Every discovery link must resolve, or Codex finds no skills (core.symlinks=false checks them out as text files).
for n in ${WANT[@]+"${WANT[@]}"}; do
  [[ -L ".agents/skills/$n" && -f ".agents/skills/$n/SKILL.md" ]] ||
    die ".agents/skills/$n/SKILL.md does not resolve; use Linux, macOS or WSL2 with core.symlinks=true"
done
echo "done: ${#WANT[@]} pstack skills vendored ($MARK); removed ${#REMOVED[@]}${REMOVED[*]+: ${REMOVED[*]}}"
