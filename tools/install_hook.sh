#!/usr/bin/env bash
# Install the post-commit hook in the SagaModel repo: every commit that touches the .blend (or assets/)
# republishes the web preview in the background. Hooks are not versioned, so this is per machine.
#   tools/install_hook.sh            install      tools/install_hook.sh --remove   uninstall
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC_REPO="${SAGA_REPO:-$HOME/Documents/Reposepos/SagaModel}"
HOOK="$(git -C "$SRC_REPO" rev-parse --git-path hooks/post-commit)"
case "$HOOK" in /*) ;; *) HOOK="$SRC_REPO/$HOOK" ;; esac
MARK="# SagaModel-web auto-publish"

if [ "${1:-}" = "--remove" ]; then
  [ -f "$HOOK" ] && sed -i "/$MARK/,/# end SagaModel-web/d" "$HOOK" && echo "removed from $HOOK"
  exit 0
fi
[ -f "$HOOK" ] || printf '#!/bin/sh\n' > "$HOOK"
if grep -q "$MARK" "$HOOK"; then echo "already installed in $HOOK"; exit 0; fi
cat >> "$HOOK" <<EOF
$MARK (installed by $HERE/tools/install_hook.sh)
if git diff-tree --no-commit-id --name-only -r HEAD | grep -qE '\.blend\$|^assets/'; then
  mkdir -p "$HERE/cache"
  nohup setsid "$HERE/tools/publish.sh" >>"$HERE/cache/publish.log" 2>&1 </dev/null &
  echo "SagaModel-web: publishing the web preview in the background (log: $HERE/cache/publish.log)"
fi
# end SagaModel-web
EOF
chmod +x "$HOOK"
echo "installed in $HOOK"
