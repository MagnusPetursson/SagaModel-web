// Fab Lab SAGA web viewer: orbit / walk / Blender camera bookmarks.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { computeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';

THREE.BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
THREE.Mesh.prototype.raycast = acceleratedRaycast;

const $ = (id) => document.getElementById(id);
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.NeutralToneMapping;   // keeps brand colours saturated (AgX desaturates; no "Punchy" look in three)
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.shadowMap.autoUpdate = false;           // static scene: render the sun shadow map once

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
const orbit = new OrbitControls(camera, canvas);
orbit.enableDamping = true;
orbit.dampingFactor = 0.12;
orbit.screenSpacePanning = true;
const plc = new PointerLockControls(camera, canvas);

const EYE = 1.6, RADIUS = 0.3, SPEED = 2.2, STEP = 0.35;
const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 2.6);
let mode = 'orbit', dirty = true, shadowPending = false, info = null, envBg = null;
const NEUTRAL = new THREE.Color(0x2a2c2e);
const solids = [];
const keys = {};
const clock = new THREE.Timer();
const ray = new THREE.Raycaster();
ray.firstHitOnly = true;

function setDirty() { dirty = true; }
orbit.addEventListener('change', setDirty);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  dirty = true;
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------ triplanar materials (from apply_pbr.py)
const texLoader = new THREE.TextureLoader();
const texCache = {};
function tex(name, srgb) {
  if (!texCache[name]) {
    const t = texLoader.load('model/tex/' + name, setDirty);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    t.anisotropy = 8;
    texCache[name] = t;
  }
  return texCache[name];
}

const TP_COMMON = /* glsl */`
uniform sampler2D tpDiff, tpRough;
uniform float tpScale, tpRot, tpTintMix, tpRMul, tpHasRough;
uniform vec3 tpHsv, tpTint, tpJoints;
varying vec3 vTpPos, vTpNrm;
vec3 tpB(vec3 w) { return vec3(w.x, -w.z, w.y); }          // web (Y up) -> Blender (Z up)
vec4 tpSample(sampler2D t, vec3 p, vec3 w) {
  return texture2D(t, p.yz) * w.x + texture2D(t, p.xz) * w.y + texture2D(t, p.xy) * w.z;
}
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0., -1./3., 2./3., -1.);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6. * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1., 2./3., 1./3.)) * 6. - 3.);
  return c.z * mix(vec3(1.), clamp(p - 1., 0., 1.), c.y);
}`;

function triplanar(mat, p) {
  mat.map = null; mat.roughnessMap = null; mat.normalMap = null;
  mat.color.set(1, 1, 1);
  mat.roughness = 1; mat.metalness = 0;
  const u = {
    tpDiff: { value: tex(p.diff, true) },
    tpRough: { value: p.rough ? tex(p.rough, false) : tex(p.diff, false) },
    tpHasRough: { value: p.rough ? 1 : 0 },
    tpScale: { value: p.scale }, tpRot: { value: p.rot_z },
    tpHsv: { value: new THREE.Vector3(...(p.hsv || [0.5, 1, 1])) },
    tpTint: { value: new THREE.Vector3(...(p.tint || [1, 1, 1])) }, tpTintMix: { value: p.tint ? p.tint_mix : 0 },
    tpRMul: { value: p.rough_mul },
    tpJoints: { value: new THREE.Vector3(...(p.joints || [0, 0, 0])) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec3 vTpPos, vTpNrm;\n' + sh.vertexShader.replace('#include <fog_vertex>', `#include <fog_vertex>
      vec4 tpW = modelMatrix * vec4(transformed, 1.0);
      vTpPos = tpW.xyz;
      vTpNrm = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\n' + TP_COMMON)
      .replace('#include <map_fragment>', `
        vec3 tpP = tpB(vTpPos) * tpScale;
        float tc = cos(tpRot), ts = sin(tpRot);
        tpP.xy = mat2(tc, ts, -ts, tc) * tpP.xy;
        vec3 tpW8 = pow(abs(tpB(normalize(vTpNrm))), vec3(6.));
        tpW8 /= (tpW8.x + tpW8.y + tpW8.z + 1e-6);
        vec3 tpCol = tpSample(tpDiff, tpP, tpW8).rgb;
        vec3 hsv = rgb2hsv(tpCol);
        hsv.x = fract(hsv.x + tpHsv.x - 0.5); hsv.y = clamp(hsv.y * tpHsv.y, 0., 1.); hsv.z *= tpHsv.z;
        tpCol = hsv2rgb(hsv);
        if (tpJoints.x > 0.) {
          vec2 g = tpJoints.xy, f = mod(tpB(vTpPos).xy, g), d = min(f, g - f);
          float m = 1. - smoothstep(tpJoints.z * 0.5, tpJoints.z, min(d.x, d.y));
          tpCol *= mix(1., 0.72, m);
        }
        tpCol = mix(tpCol, tpTint, tpTintMix);
        diffuseColor.rgb *= tpCol;`)
      .replace('#include <roughnessmap_fragment>', `
        float roughnessFactor = tpHasRough > 0.5 ? clamp(tpSample(tpRough, tpP, tpW8).r * tpRMul, 0.05, 1.) : 0.6;`);
  };
  mat.customProgramCacheKey = () => 'tp';
  mat.needsUpdate = true;
}

// ------------------------------------------------------------ lighting
function setupLights() {
  const b = info.bounds;
  const c = new THREE.Vector3().fromArray(b.min).add(new THREE.Vector3().fromArray(b.max)).multiplyScalar(0.5);
  const size = new THREE.Vector3().fromArray(b.max).sub(new THREE.Vector3().fromArray(b.min)).length();
  const sun = new THREE.DirectionalLight(0xfff1dd, 3.2);
  const d = new THREE.Vector3().fromArray(info.sun_dir).normalize();
  sun.position.copy(c).addScaledVector(d, size);
  sun.target.position.copy(c);
  sun.castShadow = true;
  sun.shadow.mapSize.set(4096, 4096);
  const s = sun.shadow.camera;
  s.left = s.bottom = -size / 2; s.right = s.top = size / 2; s.near = 0.1; s.far = size * 2;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a7f70, 0.35));   // stands in for the LED arrays
  renderer.toneMappingExposure = Math.pow(2, (info.exposure || 0) * 0.25);   // no GI here: half the Blender EV

  new HDRLoader().load('model/env.hdr', (hdr) => {
    hdr.mapping = THREE.EquirectangularReflectionMapping;
    envBg = hdr;
    scene.background = renderer.clippingPlanes.length ? NEUTRAL : hdr;
    scene.environment = new THREE.PMREMGenerator(renderer).fromEquirectangular(hdr).texture;
    scene.environmentIntensity = 0.9;
    scene.backgroundRotation.y = scene.environmentRotation.y = -(info.hdri_rot_z || 0) - Math.PI / 2;
    dirty = true;
  });
  return c;
}

// ------------------------------------------------------------ load
const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const [infoRes, verRes] = await Promise.all([fetch('model/scene.json'), fetch('model/version.json').catch(() => null)]);
info = await infoRes.json();
if (verRes && verRes.ok) {
  const v = await verRes.json();
  $('ver').textContent = v.commit ? `${v.commit} · ${v.date}` : '';
  $('ver').title = v.subject || '';
}
const centre = setupLights();

loader.load('model/saga.glb', (gltf) => {
  const glass = info.glass;                       // material name -> opacity
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      const name = m.name.replace(/\.\d+$/, '');
      if (info.triplanar[name] && !m.userData.tp) { m.userData.tp = 1; triplanar(m, info.triplanar[name]); }
      if (name in glass) {
        const isGlass = /glass/i.test(name);
        Object.assign(m, { transparent: true, opacity: glass[name], roughness: isGlass ? 0.02 : 0.18, metalness: 0,
                           depthWrite: false, side: THREE.DoubleSide });
        if (isGlass) { m.color.set(0xdfe9ee); o.castShadow = false; o.receiveShadow = false; o.userData.glass = true; }
      }
    }
    if (!o.userData.glass) { o.castShadow = true; o.receiveShadow = true; }
    solids.push(o);
  });
  scene.add(gltf.scene);
  if (!fromHash()) overview();
  shadowPending = true;
  $('loading').style.display = 'none';
  window.sagaReady = true;
  window.saga = { camera, setMode, floorAt };       // for tools/snap.mjs smoke tests
  // collision BVH off the critical path
  setTimeout(() => { for (const m of solids) m.geometry.computeBoundsTree(); }, 300);
}, (e) => {
  if (e.total) $('prog').style.width = (100 * e.loaded / e.total).toFixed(0) + '%';
  $('ltext').textContent = `Loading model… ${(e.loaded / 1048576).toFixed(1)} MB`;
}, (err) => { $('ltext').textContent = 'Failed to load model: ' + err; });

// ------------------------------------------------------------ views
function overview() {
  setMode('orbit');
  history.replaceState(null, '', location.pathname);
  const b = info.bounds;
  orbit.target.set(centre.x, 0.8, centre.z);
  const span = Math.max(b.max[0] - b.min[0], b.max[2] - b.min[2]);
  camera.position.set(centre.x + span * 0.55, span * 0.75, centre.z + span * 0.35);
  camera.fov = 45; camera.updateProjectionMatrix();
  setCut(2.6);
  orbit.update();
}

let tween = null;
function goCam(c, instant = false) {
  setMode('orbit');
  setCut(4.5);
  history.replaceState(null, '', '#cam=' + encodeURIComponent(c.name));
  tween = { t: instant ? 1 : 0, p0: camera.position.clone(), t0: orbit.target.clone(), f0: camera.fov,
            p1: new THREE.Vector3(...c.pos), t1: new THREE.Vector3(...c.target), f1: c.vfov };
}
function fromHash() {
  const v = /view=([-\d.,]+)/.exec(location.hash);          // #view=px,py,pz,tx,ty,tz[,fov] in Blender coords (Z up)
  if (v) {
    const n = v[1].split(',').map(Number);
    if (n.length >= 6 && n.every(Number.isFinite)) {
      const w = (x, y, z) => [x, z, -y];
      goCam({ name: '', pos: w(n[0], n[1], n[2]), target: w(n[3], n[4], n[5]), vfov: n[6] || 50 }, true);
      history.replaceState(null, '', '#' + v[0]);
      return true;
    }
  }
  const m = /cam=([^&]+)/.exec(location.hash);
  const c = m && info.cameras.find((k) => k.name === decodeURIComponent(m[1]));
  if (c) goCam(c, true);
  return !!c;
}
window.addEventListener('hashchange', fromHash);

function setCut(v) {
  $('cut').value = v;
  $('cutv').textContent = v >= 4.5 ? 'off' : v + ' m';
  cutPlane.constant = Number(v);
  renderer.clippingPlanes = (mode === 'orbit' && v < 4.5) ? [cutPlane] : [];
  if (envBg) scene.background = renderer.clippingPlanes.length ? NEUTRAL : envBg;   // dollhouse: plain backdrop
  dirty = true;
}
$('cut').addEventListener('input', (e) => setCut(Number(e.target.value)));
$('shadows').addEventListener('change', (e) => {
  scene.traverse((o) => { if (o.isMesh && !o.userData.glass) o.receiveShadow = e.target.checked; });
  scene.traverse((o) => { if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.needsUpdate = true); });
  dirty = true;
});

const camBox = $('cams');
const ov = document.createElement('button');
ov.textContent = 'Overview';
ov.onclick = overview;
camBox.appendChild(ov);
for (const c of info.cameras) {
  const b = document.createElement('button');
  b.textContent = c.name;
  if (c.shot_order == null) b.style.opacity = 0.6;
  b.onclick = () => goCam(c);
  camBox.appendChild(b);
}

// ------------------------------------------------------------ modes
function setMode(m) {
  if (m === mode) return;
  mode = m;
  $('mOrbit').classList.toggle('on', m === 'orbit');
  $('mWalk').classList.toggle('on', m === 'walk');
  document.body.classList.toggle('walk', m === 'walk');
  orbit.enabled = m === 'orbit';
  if (m === 'walk') {
    tween = null;
    const p = orbit.target.clone();
    camera.position.set(p.x, floorAt(p.x, p.z, 3) + EYE, p.z);
    camera.fov = 70; camera.updateProjectionMatrix();
    const look = new THREE.Vector3(); camera.getWorldDirection(look); look.y = 0;
    camera.lookAt(camera.position.clone().add(look.lengthSq() ? look : new THREE.Vector3(0, 0, -1)));
    renderer.clippingPlanes = [];
    plc.lock();
  } else {
    plc.unlock();
    const d = new THREE.Vector3(); camera.getWorldDirection(d);
    orbit.target.copy(camera.position).addScaledVector(d, 3);
    setCut(Number($('cut').value));
  }
  helpText();
  dirty = true;
}
$('mOrbit').onclick = () => setMode('orbit');
document.querySelector('#panel .title').onclick = () => $('panel').classList.toggle('min');
$('mWalk').onclick = () => setMode('walk');
canvas.addEventListener('click', () => { if (mode === 'walk' && !plc.isLocked) plc.lock(); });
plc.addEventListener('change', setDirty);

function helpText() {
  $('help').textContent = mode === 'walk'
    ? 'Click to look around · WASD / arrows move · Shift run · Q/E down/up · Esc frees the mouse'
    : 'Drag rotate · right-drag pan · wheel zoom · double-click to focus';
}
helpText();

window.addEventListener('keydown', (e) => { keys[e.code] = true; if (e.code === 'KeyF' && e.target === document.body) setMode(mode === 'walk' ? 'orbit' : 'walk'); });
window.addEventListener('keyup', (e) => { keys[e.code] = false; });

canvas.addEventListener('dblclick', (e) => {
  if (mode !== 'orbit') return;
  const ndc = new THREE.Vector2((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(solids, false).find((h) => !renderer.clippingPlanes.length || h.point.y < cutPlane.constant);
  if (hit) tween = { t: 0, p0: camera.position.clone(), t0: orbit.target.clone(), f0: camera.fov,
                     p1: camera.position.clone().add(hit.point.clone().sub(orbit.target)), t1: hit.point, f1: camera.fov };
});

// ------------------------------------------------------------ walk physics
const DOWN = new THREE.Vector3(0, -1, 0);
function floorAt(x, z, fromY) {
  ray.set(new THREE.Vector3(x, fromY, z), DOWN);
  ray.far = 10;
  const h = ray.intersectObjects(solids, false)[0];
  return h ? h.point.y : 0;
}
function blocked(pos, dir, dist) {
  for (const hgt of [0.45, 1.1, EYE - 0.1]) {
    ray.set(new THREE.Vector3(pos.x, pos.y - EYE + hgt, pos.z), dir);
    ray.far = dist + RADIUS;
    if (ray.intersectObjects(solids, false).length) return true;
  }
  return false;
}
function walk(dt) {
  const f = new THREE.Vector3(); camera.getWorldDirection(f); f.y = 0; f.normalize();
  const r = new THREE.Vector3().crossVectors(f, camera.up).normalize();
  const mv = new THREE.Vector3();
  if (keys.KeyW || keys.ArrowUp) mv.add(f);
  if (keys.KeyS || keys.ArrowDown) mv.sub(f);
  if (keys.KeyD || keys.ArrowRight) mv.add(r);
  if (keys.KeyA || keys.ArrowLeft) mv.sub(r);
  const fly = (keys.KeyE ? 1 : 0) - (keys.KeyQ ? 1 : 0);
  if (!mv.lengthSq() && !fly) return false;
  const step = SPEED * (keys.ShiftLeft || keys.ShiftRight ? 2.2 : 1) * dt;
  if (mv.lengthSq()) {
    mv.normalize();
    for (const axis of [mv, new THREE.Vector3(mv.x, 0, 0), new THREE.Vector3(0, 0, mv.z)]) {   // slide along walls
      if (!axis.lengthSq()) continue;
      const d = axis.clone().normalize();
      if (!blocked(camera.position, d, step)) { camera.position.addScaledVector(d, step * axis.length()); break; }
    }
  }
  if (fly) camera.position.y += fly * step;
  else {
    const fl = floorAt(camera.position.x, camera.position.z, camera.position.y - EYE + STEP);
    camera.position.y += (fl + EYE - camera.position.y) * Math.min(1, dt * 10);
  }
  return true;
}

// ------------------------------------------------------------ loop
let frames = 0, fpsT = 0, fps = 0;
renderer.setAnimationLoop((t) => {
  clock.update(t);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (tween) {
    tween.t = Math.min(1, tween.t + dt / 0.9);
    const k = tween.t < 0.5 ? 2 * tween.t * tween.t : 1 - Math.pow(-2 * tween.t + 2, 2) / 2;
    camera.position.lerpVectors(tween.p0, tween.p1, k);
    orbit.target.lerpVectors(tween.t0, tween.t1, k);
    camera.fov = tween.f0 + (tween.f1 - tween.f0) * k; camera.updateProjectionMatrix();
    if (tween.t >= 1) tween = null;
    dirty = true;
  }
  if (mode === 'orbit') orbit.update();
  else if (walk(dt)) dirty = true;
  if (shadowPending) {                      // shadows from the full model, before the cut plane applies
    const cp = renderer.clippingPlanes; renderer.clippingPlanes = [];
    renderer.shadowMap.needsUpdate = true; renderer.render(scene, camera);
    renderer.clippingPlanes = cp; shadowPending = false; dirty = true;
  }
  if (!dirty) return;
  dirty = false;
  renderer.render(scene, camera);
  frames++; fpsT += dt;
  if (fpsT > 0.5) { fps = frames / fpsT; frames = 0; fpsT = 0; }
  const i = renderer.info.render;
  $('stats').textContent = `${fps.toFixed(0)} fps · ${i.calls} draws · ${(i.triangles / 1e6).toFixed(2)} M tris`;
});
