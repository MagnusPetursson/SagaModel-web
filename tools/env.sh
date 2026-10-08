# Sourced by build.sh / publish.sh. The post-commit hook runs in whatever shell made the commit,
# which may not have node on PATH (here it lives under ~/.hermes/tools): find it.
if ! command -v node >/dev/null 2>&1; then
  for d in "$HOME"/.hermes/tools/node-*/bin "$HOME"/.nvm/versions/node/*/bin "$HOME"/.local/bin; do
    if [ -x "$d/node" ]; then PATH="$d:$PATH"; break; fi
  done
fi
command -v node >/dev/null 2>&1 || { echo "node not found (install Node >= 20)" >&2; exit 1; }
if [ -z "${BLENDER:-}" ]; then
  # prefer the user's own install over the distro package (/usr/bin/blender is 4.0, can't read 5.x files)
  for b in "$HOME/.local/bin/blender" $(ls -d "$HOME"/opt/blender-*/blender 2>/dev/null | sort -V -r) "$(command -v blender || true)"; do
    if [ -n "$b" ] && [ -x "$b" ]; then BLENDER="$b"; break; fi
  done
fi
"${BLENDER:?blender not found}" --version 2>/dev/null | head -1 | grep -qE "Blender ([5-9]|[1-9][0-9])\." \
  || { echo "need Blender >= 5 (found: $("$BLENDER" --version 2>/dev/null | head -1)); set BLENDER=" >&2; exit 1; }
export BLENDER PATH
