#!/usr/bin/env bash
# Build from the committed .blend, smoke-test it in headless Chrome, deploy dist/ to the gh-pages branch.
# Normally run by GitHub Actions in the SagaModel repo (.github/workflows/web-preview.yml) on every push
# that touches the .blend or assets/; safe to run by hand on any machine with Blender >= 5 and Node.
# Env: DEPLOY_REMOTE (default: this repo's origin), GIT_AUTHOR_NAME/EMAIL (default: git config),
#      SNAP_SOFT=1 for machines without a GPU (CI).
# Overlapping local calls coalesce: a call landing during a publish triggers one more round afterwards.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
. "$HERE/tools/env.sh"
mkdir -p "$HERE/cache"
LOCK="$HERE/cache/publish.lock" PENDING="$HERE/cache/publish.pending"
exec 9>"$LOCK"
if ! flock -n 9; then touch "$PENDING"; echo "publish already running; queued another round"; exit 0; fi

REMOTE="${DEPLOY_REMOTE:-$(git -C "$HERE" remote get-url origin)}"
NAME="${GIT_AUTHOR_NAME:-$(git -C "$HERE" config user.name || echo sagamodel-web)}"
EMAIL="${GIT_AUTHOR_EMAIL:-$(git -C "$HERE" config user.email || echo sagamodel-web@users.noreply.github.com)}"
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
  git -C "$HERE/dist" -c user.name="$NAME" -c user.email="$EMAIL" commit -q -m "$SUBJ"
  git -C "$HERE/dist" push -q -f "$REMOTE" gh-pages:gh-pages
  rm -rf "$HERE/dist/.git"
  echo "deployed: $SUBJ"
  [ -f "$PENDING" ] || break
done
