/* 3D base viewer (Bases tab): circular, mildly tapered LI bases cropped
   from the current domain. Uses globals from app.js: state, sliderRow, $. */
"use strict";

const BASE_OPTS = {
  count: 6, large_fraction: 0.35, d_small: 25, d_large: 40,
  base_height: 2.2, taper_deg: 3.9, px_per_mm: 5, exaggeration: 1.0,
  export_px_per_mm: 40,  // STL download resolution (40 px/mm = 25 micron)
  rim_lip_mm: 1.0,
  pins_enabled: false, pin_count: 5, pin_diameter_mm: 6.1,
  pin_depth_mm: 1.4, pin_ring_frac: 0.55, pin_noise: 0.0,
  stack_enabled: false, stack_gap_mm: 2.0,
  qr_enabled: true, qr_depth_mm: 0.25,   // traceability QR debossed in the bottom
  support_enabled: false, support_height_mm: 4.0,
  support_thickness_mm: 0.4, support_raft_mm: 2.0,
  support_base_mm: 40.0,  // clamps to disc width -> sides go straight down
};
// [key, label, min, max, step, unit, refetch?]
const BASE_PARAMS = [
  ["count", "Base count", 1, 12, 1, "", true],
  ["large_fraction", "Large share", 0, 1, 0.05, "", true],
  ["d_small", "Small Ø", 10, 40, 0.5, "mm", true],
  ["d_large", "Large Ø", 15, 60, 0.5, "mm", true],
  ["px_per_mm", "Quality", 2, 10, 0.5, "px/mm", true],
  ["base_height", "Base height", 1, 6, 0.1, "mm"],
  ["taper_deg", "Side taper", -15, 15, 0.1, "°"],  // wall angle from vertical; + = narrower at top (LI style)
  ["rim_lip_mm", "Edge lip", 0, 4, 0.1, "mm"],   // flat rim: bump map fades out before the edge
  ["exaggeration", "Relief view ×", 0.5, 4, 0.1, "x"],
];
const PIN_PARAMS = [
  ["pin_count", "Pin count", 2, 12, 1, ""],
  ["pin_diameter_mm", "Pin Ø", 0.5, 8, 0.1, "mm"],
  ["pin_depth_mm", "Pin depth", 0.2, 3, 0.05, "mm"],
  ["pin_ring_frac", "Ring radius", 0.1, 0.95, 0.01, "×R"],
  ["pin_noise", "Position noise", 0, 1, 0.02, ""],   // 1 = up to 1 mm XY error
];
const SUPPORT_PARAMS = [
  ["support_height_mm", "Height", 2, 12, 0.5, "mm"],
  ["support_thickness_mm", "Thickness", 0.4, 2.5, 0.05, "mm"],
  ["support_base_mm", "Base size", 2, 40, 0.5, "mm"],
  ["support_raft_mm", "Raft thickness", 0.8, 4, 0.1, "mm"],
];

let R3 = null;            // {renderer, scene, camera, controls, group}
let lastBases = null;
let updateExportEst = () => {};   // set in initBases; refreshes the size readout
let basesTimer = null;
let animating = false;

function ensureThree() {
  if (R3) return;
  const canvas = $("base3d");
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x191b1f);
  const camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.position.set(0, 90, 110);
  const controls = new THREE.OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;

  scene.add(new THREE.HemisphereLight(0xb9c4d6, 0x2a251d, 0.35));
  const key = new THREE.DirectionalLight(0xffffff, 0.65);
  key.position.set(-60, 45, 40);   // low sun angle so mm relief reads
  scene.add(key);
  const under = new THREE.DirectionalLight(0xcfd8e8, 0.3);   // so the bottom QR is inspectable
  under.position.set(0.5, -1, 0.3);
  scene.add(under);
  const fill = new THREE.DirectionalLight(0x7f9fd0, 0.12);
  fill.position.set(70, 30, -60);
  scene.add(fill);

  R3 = { renderer, scene, camera, controls, group: null };
  resize3d();
}

function resize3d() {
  if (!R3) return;
  const canvas = $("base3d");
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  R3.renderer.setSize(w, h, false);
  R3.camera.aspect = w / h;
  R3.camera.updateProjectionMatrix();
}

function startLoop() {
  if (animating) return;
  animating = true;
  (function tick() {
    if (!animating) return;
    requestAnimationFrame(tick);
    R3.controls.update();
    R3.renderer.render(R3.scene, R3.camera);
  })();
}

// ---------------------------------------------------------------- fetch

function scheduleBases() {
  clearTimeout(basesTimer);
  basesTimer = setTimeout(fetchBases, 400);
}

async function requestBases(ppm) {
  // one base set at the given sampling resolution; used by the viewer (low
  // ppm) and, independently, by the STL export (high ppm) without touching
  // the on-screen mesh.
  if (!state.key) return null;
  const res = await fetch("/api/bases", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: state.key,
      placement_seed: parseInt($("bases-seed").value) || 1,
      count: BASE_OPTS.count,
      large_fraction: BASE_OPTS.large_fraction,
      d_small: BASE_OPTS.d_small,
      d_large: BASE_OPTS.d_large,
      px_per_mm: ppm,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data.bases.map((b) => {
    const bin = atob(b.heights_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ...b, heights: new Float32Array(bytes.buffer) };
  });
}

let lastFetchedKey = null;   // domain key the current lastBases came from

async function fetchBases() {
  const key = state.key;
  const bases = await requestBases(BASE_OPTS.px_per_mm);
  if (!bases) return;
  lastBases = bases;
  lastFetchedKey = key;
  rebuildMeshes();
}

// ---------------------------------------------------------------- meshes

function sampleGrid(hts, n, D, x, z) {
  // grid pixel centers at (-D/2 + (i+0.5)/ppm); n px across D mm
  let gx = (x / D + 0.5) * n - 0.5;
  let gz = (z / D + 0.5) * n - 0.5;
  gx = Math.max(0, Math.min(n - 1.001, gx));
  gz = Math.max(0, Math.min(n - 1.001, gz));
  const i0 = Math.floor(gx), j0 = Math.floor(gz);
  const fx = gx - i0, fz = gz - j0;
  const a = hts[j0 * n + i0], b = hts[j0 * n + i0 + 1];
  const c = hts[(j0 + 1) * n + i0], d = hts[(j0 + 1) * n + i0 + 1];
  return (a * (1 - fx) + b * fx) * (1 - fz) + (c * (1 - fx) + d * fx) * fz;
}

// deterministic 2D hash -> [0,1), mirrors the Python lattice hash idea
function h01(i, j, seed) {
  let h = Math.imul(i | 0, 0x9E3779B1) ^ Math.imul(j | 0, 0x85EBCA77)
        ^ Math.imul(seed | 0, 0xC2B2AE3D);
  h ^= h >>> 15; h = Math.imul(h, 0x2C1B3C6D);
  h ^= h >>> 13; h = Math.imul(h, 0x297A2D39);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function basePins(baseIndex, Rt) {
  if (!BASE_OPTS.pins_enabled) return [];
  const pseed = parseInt($("bases-seed").value) || 1;
  const N = Math.max(2, Math.round(BASE_OPTS.pin_count));
  const pr = BASE_OPTS.pin_diameter_mm / 2;
  const maxR = Math.max(Rt - BASE_OPTS.rim_lip_mm - pr - 0.2, 0);
  const ringR = Math.min(BASE_OPTS.pin_ring_frac * Rt, maxR);
  const phase = h01(baseIndex, 77, pseed) * Math.PI * 2;
  const pins = [];
  for (let k = 0; k < N; k++) {
    const a = phase + (k / N) * Math.PI * 2;
    // noise dial: 1.0 = up to 1 mm radial error on the pin XY position
    const jr = h01(baseIndex, 100 + k, pseed) * BASE_OPTS.pin_noise * 1.0;
    const ja = h01(baseIndex, 200 + k, pseed) * Math.PI * 2;
    pins.push({
      x: ringR * Math.cos(a) + jr * Math.cos(ja),
      z: ringR * Math.sin(a) + jr * Math.sin(ja),
      r: pr,
    });
  }
  return pins;
}

// ------------------------------------------------------- bottom QR deboss
//
// The bottom face carries a QR code linking to the complete setup that
// produced the export (https://limp.csreades.org/b/<guid>). Dark modules
// are debossed as 45°-chamfered recesses (inverted frustums), so the
// bottom prints supportless in any orientation; a contrasting wash in the
// recesses makes it scan. The viewer shows a placeholder QR (site root)
// until an export mints a real guid.
const QR_CANONICAL = "https://limp.csreades.org";
let activeQR = null;   // {size, matrix} used by buildBaseGeometry
function placeholderQR() {
  if (!placeholderQR._q) placeholderQR._q = qrEncode(`${QR_CANONICAL}/`);
  return placeholderQR._q;
}

// depth of the deboss at base-local (x, z); 0 outside dark modules.
// Mirrored in x so the code reads correctly when the base is flipped over.
function qrDepthAt(x, z, qr, sideMM, depth) {
  const n = qr.size;
  const w = sideMM / n;
  const u = (-x + sideMM / 2) / w;    // view-from-below mirror
  const v = (z + sideMM / 2) / w;
  if (u <= 0 || v <= 0 || u >= n || v >= n) return 0;
  const cx = Math.floor(u), cy = Math.floor(v);
  if (qr.matrix[cy * n + cx] !== 1) return 0;
  const du = Math.min(u - cx, cx + 1 - u) * w;
  const dv = Math.min(v - cy, cy + 1 - v) * w;
  return Math.min(depth, Math.min(du, dv));   // 45° chamfer walls
}

function buildBaseGeometry(base, baseIndex, exOverride, caps, weld) {
  const { heights, n, diameter: D, mean } = base;
  // LI bases are widest at the table and narrow toward the top surface:
  // nominal diameter D at the bottom, top pulled in by the taper. Fixed
  // wall angle: inset = height * tan(angle), so every base shares one angle
  // (e.g. 3.9deg -> a 25mm base of height 2.2 tops out at 24.7mm).
  const Rb = D / 2;                                    // bottom radius
  const H = BASE_OPTS.base_height;
  const inset = H * Math.tan((BASE_OPTS.taper_deg * Math.PI) / 180);
  const Rt = Math.min(Math.max(Rb - inset, Rb * 0.4), Rb * 1.6);
  const ex = exOverride !== undefined ? exOverride : BASE_OPTS.exaggeration;
  // match mesh density to the height grid so the rim is as sharp as the
  // center (polar sector spacing grows with radius)
  const ppm = base.px_per_mm;
  // viewer stays light (caps 160/640); export passes far higher caps so the
  // triangle grid can actually resolve the requested pixel pitch.
  const maxRings = caps ? caps.rings : 160;
  const maxSect = caps ? caps.sect : 640;
  const RINGS = Math.min(Math.max(Math.round((D / 2) * ppm * 1.2), 32), maxRings);
  const SECT = Math.min(Math.max(Math.round(Math.PI * D * ppm * 1.2), 96), maxSect);

  const pos = [];
  // edge lip: displacement fades to exactly 0 over the last rim_lip_mm,
  // so the outer edge stays a crisp flat circle whatever the bump map does
  const lip = BASE_OPTS.rim_lip_mm;
  const surf = (x, z) => {
    let f = 1.0;
    if (lip > 0) {
      const t = Math.min(Math.max((Rt - Math.hypot(x, z)) / lip, 0), 1);
      f = t * t * (3 - 2 * t);
    }
    return H + (sampleGrid(heights, n, D, x, z) - mean) * ex * f;
  };
  // pins: flat-floored sockets, depth measured from the surface at the pin
  const pins = basePins(baseIndex, Rt);
  for (const p of pins) {
    // depth measured from the NOMINAL slab top (base_height), not the
    // textured surface: every socket floor sits on one global plane
    // (base_height - pin_depth) so mounted models are all at the same
    // height, on every pin of every base. Terrain only changes how deep
    // the socket rim is. Clamped to keep >=0.6 mm of printable material.
    p.floor = Math.max(H - BASE_OPTS.pin_depth_mm, 0.6);
  }
  const topY = (x, z) => {
    let y = surf(x, z);
    for (const p of pins) {
      const dx = x - p.x, dz = z - p.z;
      // strict flat floor: also fills terrain dips inside the socket so
      // pins/magnets always seat on a true plane
      if (dx * dx + dz * dz <= p.r * p.r) y = p.floor;
    }
    return y;
  };

  pos.push(0, topY(0, 0), 0);                          // 0: top center
  for (let i = 1; i <= RINGS; i++) {
    const r = (i / RINGS) * Rt;
    for (let j = 0; j < SECT; j++) {
      const a = (j / SECT) * Math.PI * 2;
      const x = r * Math.cos(a), z = r * Math.sin(a);
      pos.push(x, topY(x, z), z);
    }
  }
  const rimStart = 1 + (RINGS - 1) * SECT;             // top rim ring index
  // Viewer: duplicate the rim ring so computeVertexNormals gives a sharp
  // edge. Export (weld=true): share the ring instead — duplicated indices
  // split each base into two open-edged components in index-based formats
  // (3MF), which slicers report as unconnected geometry.
  let wallTop;
  if (weld) {
    wallTop = rimStart;
  } else {
    wallTop = pos.length / 3;
    for (let j = 0; j < SECT; j++) {
      const k = (rimStart + j) * 3;
      pos.push(pos[k], pos[k + 1], pos[k + 2]);
    }
  }
  const wallBot = pos.length / 3;
  for (let j = 0; j < SECT; j++) {
    const a = (j / SECT) * Math.PI * 2;
    pos.push(Rb * Math.cos(a), 0, Rb * Math.sin(a));
  }
  // bottom: flat fan normally; with QR enabled, a polar grid dense enough
  // to resolve the debossed modules inside the QR square, then one jump
  // ring out to the rim (the rest of the bottom stays flat).
  const qr = BASE_OPTS.qr_enabled ? (activeQR || placeholderQR()) : null;
  const qrSide = 0.62 * D;
  const qrDepth = BASE_OPTS.qr_depth_mm;
  const botY = qr ? ((x, z) => qrDepthAt(x, z, qr, qrSide, qrDepth)) : (() => 0);
  let botRings = [];                 // vertex index of each bottom ring
  const botCenter = pos.length / 3;
  pos.push(0, botY(0, 0), 0);
  if (qr) {
    const rq = Math.min(Rb - 0.5, qrSide * 0.75);
    const step = Math.max(0.06, 1.0 / ppm);
    const nq = Math.max(8, Math.ceil(rq / step));
    for (let i = 1; i <= nq; i++) {
      const r = (i / nq) * rq;
      botRings.push(pos.length / 3);
      for (let j = 0; j < SECT; j++) {
        const a = (j / SECT) * Math.PI * 2;
        const x = r * Math.cos(a), z = r * Math.sin(a);
        pos.push(x, botY(x, z), z);
      }
    }
  }
  botRings.push(wallBot);            // outermost bottom ring = wall base

  const idx = [];
  for (let j = 0; j < SECT; j++)                        // top center fan
    idx.push(0, 1 + j, 1 + ((j + 1) % SECT));
  for (let i = 0; i < RINGS - 1; i++) {                 // top ring quads
    const a0 = 1 + i * SECT, a1 = 1 + (i + 1) * SECT;
    for (let j = 0; j < SECT; j++) {
      const j1 = (j + 1) % SECT;
      idx.push(a0 + j, a1 + j, a1 + j1, a0 + j, a1 + j1, a0 + j1);
    }
  }
  for (let j = 0; j < SECT; j++) {                      // tapered wall
    const j1 = (j + 1) % SECT;
    idx.push(wallTop + j, wallBot + j, wallBot + j1,
             wallTop + j, wallBot + j1, wallTop + j1);
  }
  for (let j = 0; j < SECT; j++)                        // bottom center fan
    idx.push(botCenter, botRings[0] + ((j + 1) % SECT), botRings[0] + j);
  for (let i = 0; i < botRings.length - 1; i++) {       // bottom ring quads
    const b0 = botRings[i], b1 = botRings[i + 1];
    for (let j = 0; j < SECT; j++) {
      const j1 = (j + 1) % SECT;
      idx.push(b0 + j, b1 + j1, b1 + j,
               b0 + j, b0 + j1, b1 + j1);
    }
  }

  // angle runs +x -> +z, which is clockwise seen from +y: flip winding so
  // faces point outward (top up, walls out, bottom down)
  for (let k = 0; k < idx.length; k += 3) {
    const t = idx[k + 1];
    idx[k + 1] = idx[k + 2];
    idx[k + 2] = t;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildSupportGeometries(base) {
  // Thin tab flush with the base's bottom face, coming off the rim
  // sideways (+x) as viewed here; parts print rotated 90° (disc on edge,
  // tab down). The tab's inner edge hugs the rim over a full 180° (a
  // crescent with its weld line just inside the rim -- maximum edge
  // support, still snaps off), then sweeps to a straight line at the
  // plate. A thicker raft box sits on the plate for adhesion.
  const Rb = base.diameter / 2;
  const tf = BASE_OPTS.support_thickness_mm;   // plate thickness (local y)
  const S = BASE_OPTS.support_height_mm;       // rim -> build plate distance
  const L = Math.min(BASE_OPTS.support_base_mm, 2 * Rb) / 2;
  const Ri = Rb - 0.5;                         // weld line inside the rim
  const xB = Rb + S;

  // outline sampled manually (no duplicate seam points -> clean mesh):
  // 180° inner arc just inside the rim, bezier out to the bottom line,
  // across the line, bezier back up to the arc start
  const pts = [];
  const NA = 60, NB = 26;
  for (let k = 0; k <= NA; k++) {
    const th = Math.PI / 2 - (k / NA) * Math.PI;
    pts.push(new THREE.Vector2(Ri * Math.cos(th), Ri * Math.sin(th)));
  }
  const quad = (x0, y0, cx, cy, x1, y1, t) => new THREE.Vector2(
    (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1,
    (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1);
  for (let k = 1; k <= NB; k++) {   // (0,-Ri) -> (xB,-L), bulging past rim
    pts.push(quad(0, -Ri, Rb * 0.88, -(Rb + 0.55), xB, -L, k / NB));
  }
  pts.push(new THREE.Vector2(xB, L));  // across the bottom line
  for (let k = 1; k < NB; k++) {    // (xB,+L) -> (0,+Ri), mirrored; stops
    pts.push(quad(xB, L, Rb * 0.88, Rb + 0.55, 0, Ri, k / NB));
  }                                 // short of the arc start (auto-close)
  const tab = new THREE.ExtrudeGeometry(new THREE.Shape(pts), {
    depth: tf, bevelEnabled: false,
  });
  // extrude space (sx, sy, sz) -> base-local (x=sx, y=sz, z=-sy);
  // determinant +1, so face winding is preserved
  const p = tab.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const sx = p.getX(i), sy = p.getY(i), sz = p.getZ(i);
    p.setXYZ(i, sx, sz, -sy);
  }
  tab.computeVertexNormals();

  const raftT = Math.max(BASE_OPTS.support_raft_mm, tf + 0.3);
  // raft: thickness raftT (slider), 2 mm tall off the plate, exactly the
  // base width long (2L clamps to the disc diameter at the default
  // support_base_mm). Centered on the disc's mid-thickness (base_height/2),
  // not the thin tab, so on the plate it sits symmetrically under the
  // on-edge disc instead of sticking out one side.
  const raftH = 2.0;
  // ...but never so high that it loses contact with the tab (thin rafts):
  // keep the raft's lower face at least 0.1 mm into the tab's thickness.
  const cy = Math.min(BASE_OPTS.base_height / 2, tf - 0.1 + raftT / 2);
  const raft = new THREE.BoxGeometry(raftH, raftT, 2 * L);
  raft.translate(xB - raftH / 2, cy, 0);
  return [tab, raft];
}

function baseGeometries(exOverride, basesArr, caps, weld) {
  // all closed shells for the given bases (base + optional support tab)
  const bases = basesArr || lastBases;
  const offs = layoutOffsets(bases);
  const out = [];
  bases.forEach((b, i) => {
    out.push({ g: buildBaseGeometry(b, i, exOverride, caps, weld), off: offs[i], base: b, i });
    if (BASE_OPTS.support_enabled) {
      for (const g of buildSupportGeometries(b)) {
        out.push({ g, off: offs[i], base: b, i });
      }
    }
  });
  return out;
}

function rebuildMeshes() {
  if (!R3 || !lastBases) return;
  if (R3.group) {
    R3.scene.remove(R3.group);
    R3.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
  }
  const group = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x8f939c, roughness: 0.9, metalness: 0.0,
  });

  const stackPrint = BASE_OPTS.stack_enabled && BASE_OPTS.support_enabled;
  for (const { g, off, base } of baseGeometries()) {
    const mesh = new THREE.Mesh(g, mat);
    if (stackPrint) {
      // show true print orientation: disc on edge, tab down, raft on the
      // ground plane; rack rise runs along local y -> viewer -z:
      // local (x,y,z) -> viewer (z, zTop - x, -(y + rise))
      const zTop = base.diameter / 2 + BASE_OPTS.support_height_mm;
      mesh.matrixAutoUpdate = false;
      mesh.matrix.set(
        0, 0, 1, 0,
        -1, 0, 0, zTop,
        0, -1, 0, -(off[2] || 0),
        0, 0, 0, 1);
    } else {
      mesh.position.set(off[0], off[2] || 0, off[1]);
    }
    group.add(mesh);
  }
  R3.scene.add(group);
  R3.group = group;

  const stats = lastBases.map((b, i) =>
    `<div>#${i + 1} · Ø${b.diameter} mm · relief ${(b.max - b.min).toFixed(2)} mm ` +
    `· @(${b.x}, ${b.y}) rot ${b.rotation}°</div>`).join("");
  $("bases-stats").innerHTML = stats;
  updateExportEst();
}

// ---------------------------------------------------------------- STL export

function layoutOffsets(bases) {
  // offsets are [x, z, stackRise]; stackRise is only nonzero in
  // stack-for-print mode (it is a vertical offset: viewer y / STL z)
  const count = bases.length;
  if (BASE_OPTS.stack_enabled) {
    if (BASE_OPTS.support_enabled) {
      // print-orientation units racked along their thin axis (the disc
      // thickness direction) like plates in a rack: every raft stays flat
      // on the build plate (all raft bottoms coplanar at z=0), units
      // upright and center-aligned, `gap` of clearance between them
      const H = BASE_OPTS.base_height;
      const tf = BASE_OPTS.support_thickness_mm;
      const raftT = Math.max(BASE_OPTS.support_raft_mm, tf + 0.3);
      const cy = Math.min(H / 2, tf - 0.1 + raftT / 2);
      let cursor = 0;
      return bases.map((b) => {
        // unit extent along the thin (local y) axis: disc slab + relief
        // peak on one side, raft overhang (if any) on the other
        const yMin = Math.min(0, cy - raftT / 2);
        const yMax = Math.max(H + (b.max - b.mean), cy + raftT / 2);
        const off = [0, 0, cursor - yMin];
        cursor += (yMax - yMin) + BASE_OPTS.stack_gap_mm;
        return off;
      });
    }
    // no supports: flat upright column, base i sits base_height + gap
    // above the one below, first base on the plate
    const pitch = BASE_OPTS.base_height + BASE_OPTS.stack_gap_mm;
    return bases.map((_, i) => [0, 0, i * pitch]);
  }
  const perRow = Math.ceil(Math.sqrt(count));
  const pitch = Math.max(BASE_OPTS.d_small, BASE_OPTS.d_large) + 14;
  const rows = Math.ceil(count / perRow);
  return Array.from({ length: count }, (_, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    return [(c - (perRow - 1) / 2) * pitch, (r - (rows - 1) / 2) * pitch, 0];
  });
}

async function doExport(kind) {
  if (!lastBases || !lastBases.length) return;
  const btn = kind === "3mf" ? $("bases-export3mf") : $("bases-export");
  const label0 = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Rendering high-res…";
  // Fetch a fresh, high-resolution base set purely for export; the viewer
  // keeps its light mesh. Density caps scale with the export ppm so the STL
  // carries detail down to the requested pixel pitch (40 px/mm = 25 micron).
  let hbases = null;
  try {
    hbases = await requestBases(BASE_OPTS.export_px_per_mm);
  } catch (e) {
    console.error("high-res export fetch failed:", e);
  } finally {
    btn.disabled = false;
    btn.textContent = label0;
  }
  if (!hbases || !hbases.length) {
    alert("High-res render failed (server busy or restarted) — try again.");
    return;
  }
  // mint the export record FIRST so its guid can be baked into the QR
  const placeSeed0 = parseInt($("bases-seed").value) || 1;
  const record = {
    base_opts: { ...BASE_OPTS },
    placement_seed: placeSeed0,
    terrain: { seed: state.seed, config: state.config },
  };
  let guid = null, minted = null;
  if (window.__reuse_guid) {
    // re-export of an existing record (scripts/reexport.py): keep the
    // original guid so the QR, filename and /b/ link stay unchanged
    guid = window.__reuse_guid;
    try {
      const r = await fetch(`/api/exports/${guid}`);
      const rec = await r.json();
      minted = { guid, schema: rec.schema,
                 generator_commit: rec.current_generator_commit };
    } catch (e) { minted = { guid, schema: 1, generator_commit: "reexport" }; }
  } else try {
    const r = await fetch("/api/log_export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (r.ok) { minted = await r.json(); guid = minted.guid; }
  } catch (e) { /* offline: export continues with placeholder QR */ }

  btn.textContent = "Building mesh…";
  btn.disabled = true;
  // yield one frame so the label paints before the heavy synchronous meshing
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    activeQR = guid ? qrEncode(`${QR_CANONICAL}/b/${guid}`) : null;
    if (kind === "3mf") await export3MFGeos(hbases, record, minted);
    else exportSTLGeos(hbases, record, guid);
  } finally {
    activeQR = null;
    btn.disabled = false;
    btn.textContent = label0;
  }
}

// per-geo vertex transform shared by the STL and 3MF writers; both maps
// have determinant +1 so the outward winding is preserved
function geoMap(off, base, i, nBases, printMode, stacked, pitch) {
  const [ox, oz, oy = 0] = off;
  const rowX = stacked ? 0 : (i - (nBases - 1) / 2) * pitch;
  const zTop = base.diameter / 2 + BASE_OPTS.support_height_mm;
  if (printMode)
    return (x, y, z) => [z + rowX, y + (stacked ? oy : 0), zTop - x];
  return (x, y, z) => [x + ox, -(z + oz), y + oy];
}

// Position-weld a non-indexed (soup) mesh into indexed form. 3MF
// connectivity is by index, so soup arrives in slicers as one
// disconnected part PER TRIANGLE (the support tab is an ExtrudeGeometry,
// which three.js emits non-indexed — thousands of phantom parts).
function weldIndexed(positions) {
  const keyOf = new Map();
  const outPos = [];
  const index = new Uint32Array(positions.length / 3);
  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    const k = `${x},${y},${z}`;
    let id = keyOf.get(k);
    if (id === undefined) {
      id = outPos.length / 3;
      keyOf.set(k, id);
      outPos.push(x, y, z);
    }
    index[i] = id;
  }
  return { positions: Float32Array.from(outPos), index };
}

async function export3MFGeos(hbases, record, minted) {
  const geos = baseGeometries(1.0, hbases, { rings: 8192, sect: 32768 }, true);
  const printMode = BASE_OPTS.support_enabled;
  const stacked = BASE_OPTS.stack_enabled;
  const pitch = Math.max(BASE_OPTS.d_small, BASE_OPTS.d_large) + 8;
  const guid = minted ? minted.guid : null;
  const meshes = geos.map(({ g, off, base, i }) => {
    let positions = g.attributes.position.array;
    let index = g.index ? g.index.array : null;
    // weld soup meshes (ExtrudeGeometry tab) AND small indexed ones whose
    // faces don't share vertices (BoxGeometry raft = 6 disconnected quads
    // with 24 open edges by index); the disc grids are already welded
    if (!index) {
      ({ positions, index } = weldIndexed(positions));
    } else if (positions.length / 3 <= 10000) {
      const soup = new Float32Array(index.length * 3);
      for (let k = 0; k < index.length; k++) {
        soup[k * 3] = positions[index[k] * 3];
        soup[k * 3 + 1] = positions[index[k] * 3 + 1];
        soup[k * 3 + 2] = positions[index[k] * 3 + 2];
      }
      ({ positions, index } = weldIndexed(soup));
    }
    return {
      positions, index,
      map: geoMap(off, base, i, hbases.length, printMode, stacked, pitch),
    };
  });
  const meta = {
    Application: "Battlefield Heightmap Studio",
    Title: guid ? `bases ${guid}` : "bases",
    "hms:schema": minted ? minted.schema : 1,
    "hms:generator_commit": minted ? minted.generator_commit : "unknown",
    "hms:link": guid ? `${QR_CANONICAL}/b/${guid}` : "",
    "hms:record": JSON.stringify({ ...record, guid }),
  };
  const chunks = await build3MF(meshes, meta);
  geos.forEach(({ g }) => g.dispose());
  const stem = guid ? `bases_${guid}` : `bases_seed${state.seed}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(chunks, {
    type: "application/vnd.ms-package.3dmanufacturing-3dmodel+xml" }));
  a.download = `${stem}.3mf`;
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportSTLGeos(hbases, record, guid) {
  // print-true geometry: relief exaggeration forced to 1x
  const geos = baseGeometries(1.0, hbases, { rings: 8192, sect: 32768 }, true);
  const indexOf = (g) => g.index ? g.index.array
    : Uint32Array.from({ length: g.attributes.position.count }, (_, i) => i);
  let tris = 0;
  for (const { g } of geos) tris += indexOf(g).length / 3;

  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  // bake a compact param summary into the 80-byte STL header (ignored by
  // every slicer; must not start with "solid"). Full params go in the
  // .params.json sidecar + the server-side exports.jsonl log.
  const placeSeed = parseInt($("bases-seed").value) || 1;
  const hdr = (`HMS1 ${guid ? `id=${guid} ` : ""}tseed=${state.seed} place=${placeSeed} ` +
    `ppm=${BASE_OPTS.export_px_per_mm} n=${hbases.length} ` +
    `H=${BASE_OPTS.base_height} taper=${BASE_OPTS.taper_deg} ` +
    `pins=${BASE_OPTS.pins_enabled
      ? `${BASE_OPTS.pin_count}x${BASE_OPTS.pin_diameter_mm}x${BASE_OPTS.pin_depth_mm}`
      : "off"} ` +
    `sup=${BASE_OPTS.support_enabled ? 1 : 0} stack=${BASE_OPTS.stack_enabled ? 1 : 0}`
  ).slice(0, 79);
  for (let i = 0; i < hdr.length; i++) dv.setUint8(i, hdr.charCodeAt(i) & 0x7f);
  dv.setUint32(80, tris, true);
  let o = 84;
  // with supports on, export in PRINT orientation: discs on edge in a row,
  // tabs pointing down, every support line landing on z=0
  const printMode = BASE_OPTS.support_enabled;
  const stacked = BASE_OPTS.stack_enabled;
  const pitch = Math.max(BASE_OPTS.d_small, BASE_OPTS.d_large) + 8;
  const nBases = hbases.length;
  geos.forEach(({ g, off, base, i }) => {
    const p = g.attributes.position.array;
    const ix = indexOf(g);
    const [ox, oz, oy = 0] = off;
    // stack mode: one aligned rack (no row spread); each unit is only
    // translated along the thin axis (STL Y) — geometry/supports and the
    // raft-on-plate plane (z=0) unchanged
    const rowX = stacked ? 0 : (i - (nBases - 1) / 2) * pitch;
    const zTop = base.diameter / 2 + BASE_OPTS.support_height_mm;
    for (let k = 0; k < ix.length; k += 3) {
      // both maps have determinant +1 so the winding stays outward:
      //   flat:  (x, y, z) -> (x, -z, y)         (three.js y-up -> STL z-up)
      //   print: (x, y, z) -> (z + row, y, zTop - x)   (disc on edge)
      const v = [];
      for (let m = 0; m < 3; m++) {
        const a = ix[k + m] * 3;
        if (printMode) {
          v.push([p[a + 2] + rowX, p[a + 1] + (stacked ? oy : 0), zTop - p[a]]);
        } else {
          // flat/stacked: y offset (stack height) becomes STL z
          v.push([p[a] + ox, -(p[a + 2] + oz), p[a + 1] + oy]);
        }
      }
      const ux = v[1][0] - v[0][0], uy = v[1][1] - v[0][1], uz = v[1][2] - v[0][2];
      const wx = v[2][0] - v[0][0], wy = v[2][1] - v[0][1], wz = v[2][2] - v[0][2];
      let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
      const l = Math.hypot(nx, ny, nz) || 1;
      dv.setFloat32(o, nx / l, true);
      dv.setFloat32(o + 4, ny / l, true);
      dv.setFloat32(o + 8, nz / l, true);
      o += 12;
      for (const vv of v) {
        dv.setFloat32(o, vv[0], true);
        dv.setFloat32(o + 4, vv[1], true);
        dv.setFloat32(o + 8, vv[2], true);
        o += 12;
      }
      o += 2; // attribute byte count = 0
    }
    g.dispose();
  });

  const stem = guid ? `bases_${guid}` : `bases_seed${state.seed}_place${placeSeed}`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: "model/stl" }));
  a.download = `${stem}.stl`;
  a.click();
  URL.revokeObjectURL(a.href);

  // sidecar next to the STL (server already holds the same record by guid)
  const side = { ...record, guid, tris, file: `${stem}.stl`,
                 link: guid ? `${QR_CANONICAL}/b/${guid}` : null };
  const j = document.createElement("a");
  j.href = URL.createObjectURL(new Blob(
    [JSON.stringify(side, null, 1)], { type: "application/json" }));
  j.download = `${stem}.params.json`;
  j.click();
  URL.revokeObjectURL(j.href);
}

async function refreshBasesPresets() {
  const data = await (await fetch("/api/bases_presets")).json();
  const sel = $("bases-preset-list");
  sel.innerHTML = "";
  for (const name of data.presets) {
    const o = document.createElement("option");
    o.value = o.textContent = name;
    sel.appendChild(o);
  }
}

// ---------------------------------------------------------------- wiring

const basesRows = [];       // {key, row} for config-load resync
const basesChecks = {};     // key -> checkbox element

// Rebuilding every base mesh is heavy (seconds at high quality); dragging a
// slider fires input events continuously, so debounce local rebuilds — only
// the last position within 150 ms actually rebuilds.
let meshTimer = 0;
function scheduleMeshes() {
  clearTimeout(meshTimer);
  meshTimer = setTimeout(rebuildMeshes, 150);
}

function addBaseSliders(wrap, params) {
  for (const [key, label, min, max, step, unit, refetch] of params) {
    const row = sliderRow(label, BASE_OPTS[key], min, max, step, unit,
      (v) => {
        BASE_OPTS[key] = v;
        if (refetch) scheduleBases();
        else scheduleMeshes();    // local-only rebuild, no refetch
      });
    basesRows.push({ key, row });
    wrap.appendChild(row);
  }
}

function addToggle(wrap, key, label) {
  const row = document.createElement("div");
  row.className = "row";
  const chk = document.createElement("input");
  chk.type = "checkbox";
  chk.checked = BASE_OPTS[key];
  chk.addEventListener("change", () => {
    BASE_OPTS[key] = chk.checked;
    scheduleMeshes();
  });
  const lab = document.createElement("label");
  lab.textContent = label;
  lab.style.flex = "1";
  row.append(chk, lab);
  basesChecks[key] = chk;
  wrap.appendChild(row);
}

function syncBaseControls() {
  for (const { key, row } of basesRows) row._sync(BASE_OPTS[key]);
  for (const [key, chk] of Object.entries(basesChecks)) chk.checked = !!BASE_OPTS[key];
}

function initBases() {
  const wrap = $("bases-controls");
  addBaseSliders(wrap, BASE_PARAMS);

  const pinsHead = document.createElement("h3");
  pinsHead.textContent = "Pin sockets (subtracted)";
  wrap.appendChild(pinsHead);
  addToggle(wrap, "pins_enabled", "Subtract pins");
  addBaseSliders(wrap, PIN_PARAMS);

  const supHead = document.createElement("h3");
  supHead.textContent = "Print support";
  wrap.appendChild(supHead);
  addToggle(wrap, "support_enabled", "Include support");
  addBaseSliders(wrap, SUPPORT_PARAMS);

  // stack-for-print: one upright, center-aligned column with controllable
  // clear spacing; overrides the on-edge support layout when enabled
  const stackHead = document.createElement("h3");
  stackHead.textContent = "Stack for print";
  wrap.appendChild(stackHead);
  addToggle(wrap, "stack_enabled", "Stack upright (aligned column)");
  addBaseSliders(wrap, [
    ["stack_gap_mm", "Stack spacing", 0, 15, 0.25, "mm"],
  ]);
  const stackNote = document.createElement("div");
  stackNote.className = "row";
  stackNote.style.fontSize = "11px";
  stackNote.style.opacity = "0.75";
  stackNote.textContent =
    "Racks the print-orientation units along their thin axis — upright, " +
    "aligned, every raft flat on the plate (z=0). Spacing = clearance " +
    "between units. No splitting or rotating needed.";
  wrap.appendChild(stackNote);

  // STL export resolution — independent of the viewer "Quality". The mesh at
  // this pitch is only ever built at download time, never rendered on screen.
  const expHead = document.createElement("h3");
  expHead.textContent = "STL export";
  wrap.appendChild(expHead);
  addToggle(wrap, "qr_enabled", "QR code on bottom (links to this setup)");
  const qrNote = document.createElement("div");
  qrNote.className = "row";
  qrNote.style.fontSize = "11px";
  qrNote.style.opacity = "0.75";
  qrNote.textContent =
    "Debossed 45°-chamfered modules, 0.25 mm deep — prints supportless; " +
    "add a contrasting wash to scan. Viewer shows a placeholder; the real " +
    "per-export link is baked in at download time.";
  wrap.appendChild(qrNote);
  const expNote = document.createElement("div");
  expNote.className = "row";
  expNote.style.fontSize = "11px";
  expNote.style.opacity = "0.75";
  updateExportEst = () => {
    const ppm = BASE_OPTS.export_px_per_mm;
    const micron = Math.round(1000 / ppm);
    let tris = 0;
    for (const b of (lastBases || [])) {
      const D = b.diameter;
      const rings = Math.min(Math.round((D / 2) * ppm * 1.2), 8192);
      const sect = Math.min(Math.round(Math.PI * D * ppm * 1.2), 32768);
      tris += 2 * rings * sect + 2 * sect;   // top surface + wall (approx)
    }
    const mb = (84 + tris * 50) / 1048576;
    expNote.textContent = tris
      ? `${micron} µm/px · ~${(tris / 1e6).toFixed(1)} M tris · ~${mb.toFixed(0)} MB` +
        (mb > 400 ? "  ⚠ large — may be slow to slice" : "")
      : `${micron} µm/px`;
  };
  const expRow = sliderRow("Download res", BASE_OPTS.export_px_per_mm, 5, 50, 1,
    "px/mm", (v) => { BASE_OPTS.export_px_per_mm = v; updateExportEst(); });
  basesRows.push({ key: "export_px_per_mm", row: expRow });
  wrap.appendChild(expRow);
  wrap.appendChild(expNote);
  updateExportEst();

  $("bases-reroll").addEventListener("click", () => {
    $("bases-seed").value = Math.floor(Math.random() * 1e6);
    fetchBases();
  });
  $("bases-seed").addEventListener("change", fetchBases);
  $("bases-generate").addEventListener("click", fetchBases);
  $("bases-export").addEventListener("click", () => doExport("stl"));
  $("bases-export3mf").addEventListener("click", () => doExport("3mf"));

  refreshBasesPresets();
  $("bases-preset-save").addEventListener("click", async () => {
    const name = $("bases-preset-name").value.trim();
    if (!name) return;
    await fetch("/api/bases_presets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name, base_opts: BASE_OPTS,
        placement_seed: parseInt($("bases-seed").value) || 1,
        config: state.config, seed: state.seed,   // embed page-1 terrain
      }),
    });
    refreshBasesPresets();
  });
  $("bases-preset-load").addEventListener("click", async () => {
    const name = $("bases-preset-list").value;
    if (!name) return;
    const res = await fetch(`/api/bases_presets/${encodeURIComponent(name)}`);
    if (!res.ok) return;
    const data = await res.json();
    Object.assign(BASE_OPTS, data.base_opts || {});
    $("bases-seed").value = data.placement_seed;
    syncBaseControls();
    // apply the embedded terrain config to the whole app (map included)
    state.config = data.config;
    state.seed = data.seed;
    state.key = data.key;
    state.heightRange = data.height_range;
    syncControls();
    tileCache.clear();
    draw();
    fetchBases();
  });

  window.addEventListener("tabchange", (e) => {
    const active = e.detail === "bases";
    $("base3d").hidden = !active;
    $("base3d-hint").hidden = !active;
    if (active) {
      ensureThree();
      resize3d();
      // refetch if never fetched OR the terrain config changed while this
      // tab was hidden (configpushed only refetches when visible)
      if (!lastBases || lastFetchedKey !== state.key) fetchBases();
      startLoop();
    } else {
      animating = false;
    }
  });
  window.addEventListener("configpushed", () => {
    if (!$("base3d").hidden) scheduleBases();
  });
  window.addEventListener("resize", resize3d);
}

initBases();
