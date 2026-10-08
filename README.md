# SagaModel-web

Live, performant web preview of the **Fab Lab SAGA** Blender model
(private source repo `MagnusPetursson/SagaModel`, file `SagaV2_work.blend`).

Site: https://magnuspetursson.github.io/SagaModel-web/

- **Orbit**: dollhouse cutaway with an adjustable cut height
- **Walk**: first-person at 1.6 m eye height with collision (WASD, mouse look, Shift run, Q/E fly)
- **Views**: every Blender camera as a bookmark, ordered by `shot_order` (grey = not in the finals set);
  deep links like `#cam=MuralFront`

## How it updates

```
SagaModel commit touching the .blend or assets/
  └─ .git/hooks/post-commit  (installed by tools/install_hook.sh, background, logs to cache/publish.log)
       └─ tools/publish.sh
            ├─ tools/build.sh   git show HEAD:SagaV2_work.blend → headless Blender export/export_glb.py
            │                   → gltf-transform (meshopt, WebP 1k, join/weld/simplify) → dist/
            ├─ tools/snap.mjs   headless Chrome smoke test (fails on page errors / load timeout)
            └─ force-push dist/ as a single orphan commit to gh-pages  (no history bloat)
```

Manual: `tools/publish.sh` (committed HEAD), or `tools/build.sh --file ~/…/SagaV2_work.blend` to preview the
live working copy locally (`cd dist && python3 -m http.server`). Screenshots of any views:
`node tools/snap.mjs out/ overview MuralFront LaserDetail`.

The exporter never writes the .blend: it works on a copy and only changes things in memory.

## What the exporter translates

- Render-visible mesh/text objects only (hidden colleague leftovers stay out), modifiers applied; no lights.
- `apply_pbr.py` materials use **world-space triplanar** projection (no UVs). Their parameters
  (Poly Haven texture, scale, rotation, HSV correction, tint, roughness multiplier, formwork joints) are read
  from the node graph into `scene.json`, and the viewer rebuilds the projection in a shader patch.
- Procedural base colours (Flöff felt, cutting mats) are frozen to the material's viewport colour.
- Thin glass and SAMLA clear plastic get their opacity; the procedural pegboard stays opaque.
- Cameras (position, aim, vertical FOV, shot_order), sun direction, HDRI rotation and exposure come from the file.

Lighting is real-time: the same Poly Haven HDRI (1k) for image-based light plus the scene's sun with a
shadow map rendered once (static scene). Neutral tone mapping keeps the brand colours saturated. There's no
GI, so interiors read brighter and flatter than the Cycles stills, by design.

## Setup on a new machine

Needs Blender (5.x) on PATH, Node ≥ 20, git push access to this repo.

```
npm ci                 # gltf-transform + puppeteer (downloads headless Chrome)
tools/install_hook.sh  # per machine; --remove to uninstall
```

## Licensing

Everything published is CC0 (Poly Haven textures, drill and cardboard-box models, HDRI
`buikslotermeerplein`) or the Fab Lab's own material (generated brand mural, zone signs, logo). See
`LICENSES.md` in the source repo. Viewer code: MIT. three.js and three-mesh-bvh are loaded from jsDelivr (MIT).
