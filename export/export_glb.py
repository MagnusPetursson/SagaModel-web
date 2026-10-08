"""Export the Fab Lab SAGA Blender scene for the web viewer.

Run headless (never saves the .blend):
    blender -b /path/SagaV2_work.blend --python export/export_glb.py -- <out_dir>

Writes into <out_dir>:
    saga_raw.glb     every render-visible mesh/text object (modifiers applied, no lights/cameras)
    scene.json       cameras (shot_order), triplanar material params, scene bounds, sun
    tex/*.jpg        1k copies of the triplanar textures (diff + rough)

Materials built by apply_pbr.py use world-space triplanar projection (no UVs), which glTF cannot
express. Their parameters are read from the node graph here and rebuilt in the viewer's shader;
the glTF copy keeps the material name and the texture's mean colour as a fallback.
"""
import json
import math
import os
import sys

import bpy
from mathutils import Vector

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = os.path.abspath(argv[0] if argv else "build")
os.makedirs(os.path.join(OUT, "tex"), exist_ok=True)
scene = bpy.context.scene
TEX = 1024


def to_web(v):
    """Blender Z-up -> glTF Y-up (matches the glTF exporter's +Y up conversion)."""
    return [round(v[0], 4), round(v[2], 4), round(-v[1], 4)]


def lin2srgb(c):
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


# ---------------------------------------------------------------- triplanar materials
def save_tex(image, key):
    """1k JPEG copy of an image; returns the file name (relative to tex/)."""
    name = key + ".jpg"
    path = os.path.join(OUT, "tex", name)
    if not os.path.exists(path):
        im = image.copy()
        if im.size[0] > TEX or im.size[1] > TEX:
            im.scale(TEX, TEX)
        s = scene.render.image_settings
        s.file_format, s.quality, s.color_mode = "JPEG", 85, "RGB"
        im.filepath_raw = path
        im.file_format = "JPEG"
        im.save_render(path, scene=scene)
        bpy.data.images.remove(im)
    return name


def mean_colour(image):
    px = image.pixels[:]
    n = len(px) // 4
    step = max(1, n // 4096)
    acc = [0.0, 0.0, 0.0]
    for i in range(0, n, step):
        for k in range(3):
            acc[k] += px[i * 4 + k]
    cnt = len(range(0, n, step))
    return [a / cnt for a in acc]


def triplanar_params(mat):
    """Parse an apply_pbr.pbr() node graph. None if the material isn't one."""
    nt = mat.node_tree
    if not nt or not any(n.type == "NEW_GEOMETRY" for n in nt.nodes):
        return None
    mp = next((n for n in nt.nodes if n.type == "MAPPING"), None)
    imgs = [n.image for n in nt.nodes if n.type == "TEX_IMAGE" and n.image]
    diff = next((i for i in imgs if os.path.basename(i.filepath).startswith("diff")), None)
    rough = next((i for i in imgs if os.path.basename(i.filepath).startswith("rough")), None)
    if mp is None or diff is None:
        return None
    asset = os.path.basename(os.path.dirname(bpy.path.abspath(diff.filepath)))
    p = {
        "asset": asset,
        "scale": mp.inputs["Scale"].default_value[0],
        "rot_z": mp.inputs["Rotation"].default_value[2],
        "diff": save_tex(diff, asset + "_diff"),
        "rough": save_tex(rough, asset + "_rough") if rough else None,
        "hsv": None, "tint": None, "tint_mix": 0.0, "rough_mul": 1.0, "joints": None,
    }
    for n in nt.nodes:
        if n.type == "HUE_SAT":
            p["hsv"] = [n.inputs["Hue"].default_value, n.inputs["Saturation"].default_value,
                        n.inputs["Value"].default_value]
        elif n.type == "MIX" and n.data_type == "RGBA" and n.blend_type == "MIX" and not n.inputs["B"].is_linked:
            p["tint"] = list(n.inputs["B"].default_value)[:3]           # linear
            p["tint_mix"] = n.inputs["Factor"].default_value
        elif n.type == "MATH" and n.operation == "MULTIPLY" and any(
                l.to_node.type == "BSDF_PRINCIPLED" for l in n.outputs[0].links):
            p["rough_mul"] = n.inputs[1].default_value
        elif n.type == "TEX_BRICK":
            p["joints"] = [n.inputs["Brick Width"].default_value, n.inputs["Row Height"].default_value,
                           n.inputs["Mortar Size"].default_value]
    # fallback flat colour for the glTF (mean of the scan with hsv/tint applied roughly)
    c = mean_colour(diff)
    if p["hsv"]:
        c = [min(1.0, x * p["hsv"][2]) for x in c]
    if p["tint"]:
        c = [a * (1 - p["tint_mix"]) + b * p["tint_mix"] for a, b in zip(c, p["tint"])]
    p["fallback"] = c
    return p


def flatten_material(mat, p):
    """Replace the node tree with a plain Principled BSDF (only in this unsaved session)."""
    nt = mat.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    b.inputs["Base Color"].default_value = (*p["fallback"], 1)
    b.inputs["Roughness"].default_value = min(1.0, 0.6 * p["rough_mul"])
    nt.links.new(b.outputs["BSDF"], out.inputs["Surface"])


def const_colour(sock):
    """Best constant RGB for a socket fed by a procedural chain (MIX / COLOR RAMP), else None."""
    if not sock.is_linked:
        return list(sock.default_value)[:3]
    n = sock.links[0].from_node
    if n.type == "MIX" and n.data_type == "RGBA":
        a, b = const_colour(n.inputs["A"]), const_colour(n.inputs["B"])
        f = 0.5 if n.inputs["Factor"].is_linked else n.inputs["Factor"].default_value
        if a and b:
            return [x * (1 - f) + y * f for x, y in zip(a, b)]
        return a or b
    if n.type == "VALTORGB":
        return list(n.color_ramp.evaluate(0.5))[:3]
    return None


def bake_procedural_base(m):
    """glTF drops procedural base-colour chains (felt noise, cutting-mat grid): freeze them to a constant.
    Builders set material.diffuse_color to the intended colour, so prefer that."""
    nt = m.node_tree
    b = next((n for n in nt.nodes if n.type == "BSDF_PRINCIPLED"), None) if nt else None
    if b is None or not b.inputs["Base Color"].is_linked:
        return
    sock = b.inputs["Base Color"]
    if sock.links[0].from_node.type == "TEX_IMAGE":
        return
    dc = list(m.diffuse_color)[:3]
    col = dc if any(abs(x - 0.8) > 1e-3 for x in dc) else const_colour(sock)
    if col:
        nt.links.remove(sock.links[0])
        sock.default_value = (*col, 1)
        print("procedural base ->", m.name, [round(x, 3) for x in col])


# ---------------------------------------------------------------- objects to export
dg = bpy.context.evaluated_depsgraph_get()
keep = [o for o in scene.objects
        if o.type in ("MESH", "CURVE", "FONT", "SURFACE", "META") and o.visible_get() and not o.hide_render]
mats = {s.material for o in keep for s in o.material_slots if s.material}
special = {}
for m in sorted(mats, key=lambda m: m.name):
    p = triplanar_params(m)
    if p:
        special[m.name] = p
        flatten_material(m, p)
    else:
        bake_procedural_base(m)


def transparency(m):
    """Opacity for see-through materials: thin glass (fix_glass.py) or a constant transparent/BSDF mix
    (clear_plastic). Procedural masks (pegboard holes) stay opaque. None = opaque."""
    nt = m.node_tree
    if not nt or not any(n.type == "BSDF_TRANSPARENT" for n in nt.nodes):
        return None
    if "glass" in m.name.lower():
        return 0.12
    mix = next((n for n in nt.nodes if n.type == "MIX_SHADER"), None)
    if mix is None or mix.inputs[0].is_linked:
        return None
    to_tr = mix.inputs[2].is_linked and mix.inputs[2].links[0].from_node.type == "BSDF_TRANSPARENT"
    fac = mix.inputs[0].default_value
    return round(1.0 - fac if to_tr else fac, 3)


glass = {m.name: transparency(m) for m in mats if transparency(m) is not None}
print("triplanar:", sorted(special), "glass:", glass)

bpy.ops.object.select_all(action="DESELECT")
for o in keep:
    o.select_set(True)

glb = os.path.join(OUT, "saga_raw.glb")
bpy.ops.export_scene.gltf(
    filepath=glb, export_format="GLB", use_selection=True, export_apply=True,
    export_cameras=False, export_lights=False, export_extras=False, export_animations=False,
    export_yup=True, export_texcoords=True, export_normals=True, export_materials="EXPORT",
    export_image_format="AUTO",
)

# ---------------------------------------------------------------- cameras, bounds, sun
r = scene.render
aspect = (r.resolution_x * r.pixel_aspect_x) / (r.resolution_y * r.pixel_aspect_y)
cams = []
for c in sorted((o for o in scene.objects if o.type == "CAMERA"), key=lambda o: (o.get("shot_order") is None, o.get("shot_order") or 0, o.name)):
    mw = c.matrix_world
    fwd = (mw.to_3x3() @ Vector((0, 0, -1))).normalized()
    cd = c.data
    if cd.sensor_fit == "VERTICAL" or (cd.sensor_fit == "AUTO" and aspect < 1):
        vfov = cd.angle_y if cd.sensor_fit == "VERTICAL" else cd.angle
    else:
        vfov = 2 * math.atan(math.tan(cd.angle_x / 2) / aspect)
    cams.append({"name": c.name.removeprefix("Cam_"), "shot_order": c.get("shot_order"),
                 "pos": to_web(mw.translation), "target": to_web(mw.translation + fwd * 3.0),
                 "vfov": round(math.degrees(vfov), 2)})

lo = Vector((1e9,) * 3)
hi = Vector((-1e9,) * 3)
for o in keep:
    for v in o.bound_box:
        w = o.matrix_world @ Vector(v)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))

sun = next((o for o in scene.objects if o.type == "LIGHT" and o.data.type == "SUN" and not o.hide_render), None)
sun_dir = to_web((sun.matrix_world.to_3x3() @ Vector((0, 0, 1))).normalized()) if sun else [0.5, 0.6, 0.3]

world = scene.world
hdri_rot = 0.0
if world and world.node_tree:
    mp = next((n for n in world.node_tree.nodes if n.type == "MAPPING"), None)
    if mp:
        hdri_rot = mp.inputs["Rotation"].default_value[2]

info = {
    "source": os.path.basename(bpy.data.filepath),
    "cameras": cams, "triplanar": special, "glass": glass,
    "bounds": {"min": to_web(lo), "max": to_web(hi)},
    "sun_dir": sun_dir, "sun_strength": sun.data.energy if sun else 3.0,
    "hdri_rot_z": hdri_rot,
    "exposure": scene.view_settings.exposure,
    "objects": len(keep),
}
# bounds after the axis swap: y/z min/max may be flipped by the negation
b = info["bounds"]
b["min"], b["max"] = [min(a, c) for a, c in zip(b["min"], b["max"])], [max(a, c) for a, c in zip(b["min"], b["max"])]
json.dump(info, open(os.path.join(OUT, "scene.json"), "w"), indent=1)
print("EXPORT OK", glb, len(keep), "objects", len(cams), "cameras")
