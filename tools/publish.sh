#!/usr/bin/env bash
# Build from the committed .blend, smoke-test it in headless Chrome, deploy dist/ to the gh-pages branch.
# Called by the SagaModel post-commit hook (tools/install_hook.sh); safe to run by hand.
# Overlapping calls coalesce: a commit landing during a publish triggers one more round afterwards.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
. "$HERE/tools/env.sh"
mkdir -p "$HERE/cache"
LOCK="$HERE/cache/publish.lock" PENDING="$HERE/cache/publish.pending"
exec 9>"$LOCK"
if ! flock -n 9; then touch "$PENDING"; echo "publish already running; queued another round"; exit 0; fi

REMOTE="$(git -C "$HERE" remote get-url origin)"
while :; do
  rm -f "$PENDING"
  echo "=== publish $(date -u '+%F %T') UTC"
  "$HERE/tools/build.sh"
  node "$HERE/tools/snap.mjs" "$HERE/cache/shots" overview   # fails on page errors / load timeout
  # gh-pages = one orphan commit, force-pushed: the ~19 MB site never accumulates in git history
  rm -rf "$HERE/dist/.git"
  git -C "$HERE/dist" init -q -b gh-pages
  git -C "$HERE/dist" add -A
  SUBJ="$(python3 -c 'import json,sys;v=json.load(open(sys.argv[1]));print(f"Site for SagaModel {v.get("commit")}: {v.get("subject","")}"[:200])' "$HERE/dist/model/version.json")"
  git -C "$HERE/dist" -c user.name="$(git -C "$HERE" config user.name)" -c user.email="$(git -C "$HERE" config user.email)" \
      commit -q -m "$SUBJ"
  git -C "$HERE/dist" push -q -f "$REMOTE" gh-pages:gh-pages
  rm -rf "$HERE/dist/.git"
  echo "deployed: $SUBJ"
  [ -f "$PENDING" ] || break
done
