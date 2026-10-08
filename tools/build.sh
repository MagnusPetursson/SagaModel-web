#!/usr/bin/env bash
# Build the static site into dist/ from the SagaModel Blender file.
#   tools/build.sh              export the COMMITTED SagaV2_work.blend at HEAD of the SagaModel repo
#   tools/build.sh --rev REV    ...at another revision
#   tools/build.sh --file PATH  export a .blend on disk (e.g. the live working copy, uncommitted changes included)
# Env: SAGA_REPO (default ~/Documents/Reposepos/SagaModel), BLENDER (default: blender on PATH)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC_REPO="${SAGA_REPO:-$HOME/Documents/Reposepos/SagaModel}"
BLEND_REL="SagaV2_work.blend"
REV=HEAD FILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --rev) REV="$2"; shift 2 ;;
    --file) FILE="$2"; shift 2 ;;
    *) echo "unknown arg $1" >&2; exit 2 ;;
  esac
done
BUILD="$HERE/build"
DIST="$HERE/dist"
cd "$HERE"
. "$HERE/tools/env.sh"
[ -d node_modules/@gltf-transform/cli ] || npm ci --silent

rm -rf "$BUILD" && mkdir -p "$BUILD"
if [ -n "$FILE" ]; then
  cp "$FILE" "$BUILD/src.blend"
  REV="working copy"
else
  REV="$(git -C "$SRC_REPO" rev-parse --short "$REV")"
  git -C "$SRC_REPO" show "$REV:$BLEND_REL" > "$BUILD/src.blend"
fi
# the .blend references textures as //assets/...: make them resolve next to the copy
ln -s "$SRC_REPO/assets" "$BUILD/assets"
echo "exporting $BLEND_REL @ $REV"
SAGA_REPO="$SRC_REPO" "$BLENDER" -b "$BUILD/src.blend" --python export/export_glb.py -- "$BUILD" 2>&1 \
  | grep -E "triplanar|procedural base|relinked|warning:|EXPORT|^  (font|image) |Error|Traceback" || true
[ -f "$BUILD/saga_raw.glb" ] || { echo "export failed" >&2; exit 1; }

if ! node node_modules/@gltf-transform/cli/bin/cli.js optimize "$BUILD/saga_raw.glb" "$BUILD/saga.glb" \
    --compress meshopt --palette false --instance false \
    --texture-compress webp --texture-size 1024 --simplify-error 0.0001 > "$BUILD/optimize.log" 2>&1 \
   || [ ! -f "$BUILD/saga.glb" ]; then
  cat "$BUILD/optimize.log" >&2; echo "optimize failed" >&2; exit 1
fi
grep -E "^info" "$BUILD/optimize.log" || true

ENV="$HERE/cache/env_1k.hdr"     # Poly Haven CC0 'buikslotermeerplein' (same HDRI as the renders), 1k
[ -f "$ENV" ] || { mkdir -p cache; curl -sfL -o "$ENV" https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/buikslotermeerplein_1k.hdr; }

rm -rf "$DIST" && mkdir -p "$DIST/model"
cp -r site/* "$DIST/"
cp "$BUILD/saga.glb" "$BUILD/scene.json" "$DIST/model/"
cp -r "$BUILD/tex" "$DIST/model/tex"
cp "$ENV" "$DIST/model/env.hdr"
python3 - "$SRC_REPO" "$REV" "$DIST/model/version.json" <<'PY'
import json, subprocess, sys, datetime
repo, rev, out = sys.argv[1:]
v = {"built": datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%d %H:%M UTC")}
if rev != "working copy":
    h, d, s = subprocess.check_output(["git", "-C", repo, "log", "-1", "--format=%h%x1f%cs%x1f%s", rev],
                                      text=True).strip().split("\x1f")
    v.update(commit=h, date=d, subject=s)
else:
    v.update(commit="working copy", date=v["built"][:10], subject="unpublished working copy")
json.dump(v, open(out, "w"))
PY
touch "$DIST/.nojekyll"
du -sh "$DIST" "$DIST/model/saga.glb"
