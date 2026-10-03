/* 3D base viewer (Bases tab): circular, mildly tapered LI bases cropped
   from the current domain. Uses globals from app.js: state, sliderRow, $. */
"use strict";

const BASE_OPTS = {
  count: 6, large_fraction: 0.35, d_small: 25, d_large: 40,
  base_height: 2.2, taper_deg: 3.9, px_per_mm: 5, exaggeration: 1.0,
  export_px_per_mm: 40,  // STL download resolution (40 px/mm = 25 micron)
  rim_lip_mm: 1.0,
  recess_mm: 0.2, foot_ring_mm: 1.5,     // recessed bottom inside a flat foot ring
  pins_enabled: false, pin_count: 5, pin_diameter_mm: 6.1,
  pin_depth_mm: 1.4, pin_ring_frac: 0.55, pin_noise: 0.0,
  stack_enabled: false, stack_gap_mm: 2.0,
  mark: "text",          // ID on the bottom: "text" (raised code) | "qr" | "none"
  qr_depth_mm: 0.25,     // QR modules debossed into the recess floor
  support_enabled: false, support_height_mm: 2.0,   // tested in the support sweep
  support_thickness_mm: 0.4, support_raft_mm: 2.0,
  support_perf: true,                     // perforated breakaway (teeth)
  support_under: false,                   // teeth bond to the underside, not the rim
  perf_pitch_mm: 2.5, perf_contact_mm: 0.5, perf_gap_mm: 0.4,
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
  ["recess_mm", "Bottom recess", 0, 1, 0.05, "mm"],  // capped by pin sockets when pins are on
  ["foot_ring_mm", "Foot ring", 0.5, 4, 0.1, "mm"],  // flat outer ring the base stands on
  ["exaggeration", "Relief view ×", 0.5, 4, 0.1, "x"],
];
const PIN_PARAMS = [
  ["pin_count", "Pin count", 2, 12, 1, ""],
  ["pin_diameter_mm", "Pin Ø", 0.5, 8, 0.1, "mm"],
  ["pin_depth_mm", "Pin depth", 0.2, 3, 0.05, "mm"],
  ["pin_ring_frac", "Ring radius", 0.1, 0.95, 0.01, "×R"],
  ["pin_noise", "Position noise", 0, 1, 0.02, ""],   // 1 = up to 1 mm XY error
];
const PERF_PARAMS = [
  ["perf_pitch_mm", "Contact pitch", 1.2, 6, 0.1, "mm"],    // along the rim
  ["perf_contact_mm", "Contact width", 0.1, 1.5, 0.05, "mm"],
  ["perf_gap_mm", "Breakaway gap", 0.2, 1, 0.05, "mm"],
];
const SUPPORT_PARAMS = [
  ["support_height_mm", "Height", 2, 12, 0.5, "mm"],
  ["support_thickness_mm", "Thickness", 0.3, 2.5, 0.05, "mm"],
  ["support_base_mm", "Base size", 2, 40, 0.5, "mm"],
  ["support_raft_mm", "Raft thickness", 0.8, 4, 0.1, "mm"],
];

let R3 = null;            // {renderer, scene, camera, controls, group}
let lastBases = null;
let updateExportEst = () => {};   // set in initBases; refreshes the size readout
let updateRecessNote = () => {};  // set in initBases; says when pins cap the recess
let updateMarkNote = () => {};    // set in initBases; describes the bottom mark
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

async function requestBases(ppm, overrides = {}) {
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
      ...overrides,
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
// Optional mark (mark: "qr"): a QR code linking to the complete setup that
// produced the export (https://limp.csreades.org/b/<code>). Dark modules
// are debossed as 45°-chamfered recesses (inverted frustums), so the
// bottom prints supportless in any orientation; a contrasting wash in the
// recesses makes it scan. The viewer shows a placeholder QR (site root)
// until an export mints a real code. QR_CANONICAL is also the base URL of
// every record link (/b/<code>), whichever mark is printed.
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

// ------------------------------------------------ bottom recess (foot ring)
//
// The bottom can be recessed inside a flat outer foot ring, like the foot
// of a mug: the base then stands on the ring, so it sits level on small
// bumps and a slightly bowed print can't rock. 45° walls print supportless
// on edge, and the QR is debossed into the recess floor, where it never
// rubs on the table. Pin sockets win: with pins on, the recess is capped so
// the socket floors keep >= 0.6 mm of material under them.
function recessDepth() {
  let d = Math.max(0, BASE_OPTS.recess_mm || 0);
  if (BASE_OPTS.pins_enabled)
    d = Math.min(d, Math.max(0, BASE_OPTS.base_height - BASE_OPTS.pin_depth_mm - 0.6));
  return d;
}

function recessInnerRadius(D, d) {     // where the foot ring starts
  return Math.max(D / 2 - BASE_OPTS.foot_ring_mm, d + 0.5);
}

// bottom-face ring radii (centre and rim excluded): the QR grid when the
// QR is on, plus exact rings at both edges of the recess wall
function bottomRingRadii(D, ppm, qrOn, d) {
  const Rb = D / 2;
  const radii = [];
  if (qrOn) {
    const rq = Math.min(Rb - 0.5, 0.62 * D * 0.75);
    const nq = Math.max(8, Math.ceil(rq / Math.max(0.06, 1 / ppm)));
    for (let i = 1; i <= nq; i++) radii.push((i / nq) * rq);
  }
  if (d > 0) {
    const rIn = recessInnerRadius(D, d);
    radii.push(rIn - d, rIn);
  }
  radii.sort((a, b) => a - b);
  return radii.filter((r, i) => r > 1e-6 && r < Rb - 1e-6 && (i === 0 || r - radii[i - 1] > 1e-6));
}

// ------------------------------------------------------- bottom ID (raised text)
//
// The default mark: the export's 6-character code (server/app.py) as raised
// letters on the recess floor, read from below (not mirrored). They stand
// TEXT_CLEAR short of the foot ring, so they never touch the table, and
// being raised they only add material: nothing thins the floor under pin
// sockets. Letters are DejaVu Sans Mono Bold outlines baked by
// scripts/bake_glyphs.py (vendor/glyphs.js) and are joined into the bottom
// face, so each base stays one closed shell. The viewer shows a placeholder
// until an export mints the real code.
const TEXT_CLEAR = 0.05;          // letter faces to the foot-ring plane
const TEXT_MIN_RECESS = 0.15;     // shallower recesses leave no room
const TEXT_PLACEHOLDER = "XXXXXX";
let activeCode = null;            // the code baked in while an export builds

// drop repeated and collinear points: earcut silently skips them, which
// would leave the floor and the letter walls meeting at T-junctions.
// Repeats go first, then collinear points one at a time against the
// current list (judging a stale list could delete a real corner).
function cleanRing(pts) {
  const out = pts.filter((p, i) => p.distanceTo(pts[(i + pts.length - 1) % pts.length]) > 1e-4);
  for (let changed = true; changed && out.length > 3; ) {
    changed = false;
    for (let i = 0; i < out.length && out.length > 3; ) {
      const a = out[(i + out.length - 1) % out.length], p = out[i], b = out[(i + 1) % out.length];
      if (Math.abs((p.x - a.x) * (b.y - p.y) - (p.y - a.y) * (b.x - p.x)) <= 1e-10) {
        out.splice(i, 1);
        changed = true;
      } else i++;
    }
  }
  return out;
}

// The code's glyph contours in base-local (x, z) mm: one centred row, cap
// height as large as the recess floor allows (6 mm max). Each contour knows
// its nesting: even depth = letter, odd = counter (the hole in an A or a 0),
// oriented with the letter on its left. null when there's no room.
function textMarkLayout(D, rd) {
  const G = self.HMS_GLYPHS;
  if (!G || rd < TEXT_MIN_RECESS - 1e-9) return null;
  const code = String(activeCode || TEXT_PLACEHOLDER).toUpperCase();
  const pitch = G.advance * 1.1;           // a little tracking: letters never touch
  const hw = (code.length * pitch) / 2;
  // line box: y from -0.2 (Q's tail) to 1.05 cap heights; with the cap
  // height centred its farthest corner is (hw, 0.7)
  const avail = recessInnerRadius(D, rd) - rd - 0.5;    // floor radius less a margin
  const cap = Math.min(6, avail / Math.hypot(hw, 0.7));
  if (!(cap >= 1)) return null;            // under 1 mm isn't worth printing
  const contours = [];
  [...code].forEach((ch, k) => {
    const ox = -hw + k * pitch + (pitch - G.advance) / 2;
    const glyph = (G.chars[ch] || []).map((c) => {
      const pts = [];
      for (let i = 0; i < c.length; i += 2)
        pts.push(new THREE.Vector2((ox + c[i]) * cap, (c[i + 1] - 0.5) * cap));
      return { pts: cleanRing(pts), children: [] };
    }).filter((c) => c.pts.length >= 3);
    for (const c of glyph)
      c.depth = glyph.filter((o) => o !== c && insidePoly(o.pts, c.pts[0])).length;
    for (const c of glyph) {
      c.solid = c.depth % 2 === 0;
      const parent = glyph.find((o) => o.depth === c.depth - 1 && insidePoly(o.pts, c.pts[0]));
      if (parent) parent.children.push(c);
      if ((THREE.ShapeUtils.area(c.pts) > 0) !== c.solid) c.pts.reverse();
      contours.push(c);
    }
  });
  return { code, cap, contours };
}

// Upper bound on the triangles the raised code adds (export estimate):
// walls 2 per outline point, letter faces and floor about 1 each.
function textMarkTris() {
  const G = self.HMS_GLYPHS;
  if (!G) return 0;
  if (!textMarkTris.n) {
    const most = Math.max(...Object.values(G.chars).map(
      (cs) => cs.reduce((s, c) => s + c.length / 2 + 2, 0)));
    textMarkTris.n = 6 * 4 * most;
  }
  return textMarkTris.n;
}

// Mesh the recess floor with the raised code into buildBaseGeometry's
// arrays. ring0 is the bottom ring at the floor's edge (SECT vertices);
// the floor is triangulated around the letters, inside the counters too,
// and the letters get walls down to their faces at TEXT_CLEAR. Triangles
// are pushed in buildBaseGeometry's pre-flip winding (it reverses all of
// them at the end): clockwise in (x, z) for the down-facing floor and
// faces. The viewer gives the walls their own vertices for crisp edges.
function addTextMark(pos, idx, txt, ring0, SECT, rd, weld) {
  const put = (pts, y) => pts.map((p) => {
    pos.push(p.x, y, p.y);
    return pos.length / 3 - 1;
  });
  const down = (a, b, c) => {         // push facing -y (after the final flip)
    const ax = pos[a * 3], az = pos[a * 3 + 2];
    const cr = (pos[b * 3] - ax) * (pos[c * 3 + 2] - az) - (pos[b * 3 + 2] - az) * (pos[c * 3] - ax);
    if (cr < 0) idx.push(a, b, c);
    else idx.push(a, c, b);
  };
  for (const c of txt.contours) {
    c.floorIds = put(c.pts, rd);
    c.faceIds = put(c.pts, TEXT_CLEAR);
  }
  // Letters share exactly collinear corners (baselines, cap lines), and
  // earcut then runs edges straight through other corners: T-junctions,
  // closed to the eye but open by index. Split such triangles at those
  // corners so neighbours meet vertex for vertex. (Nudging the corners
  // apart instead would be undone by the 3MF's 1 µm rounding.) With the
  // ring as outer boundary its vertices are skipped: no edge can pass
  // through them.
  const fill = (outer, outerIds, holes, holeIds, ringOuter) => {
    const pts = outer.concat(...holes), ids = outerIds.concat(...holeIds);
    const first = ringOuter ? outer.length : 0;
    const onEdge = (i, j) => {          // a corner strictly inside edge i-j
      if (i < first && j < first) return -1;
      const a = pts[i], ex = pts[j].x - a.x, ey = pts[j].y - a.y, L2 = ex * ex + ey * ey;
      for (let m = first; m < pts.length; m++) {
        if (m === i || m === j) continue;
        const px = pts[m].x - a.x, py = pts[m].y - a.y, t = px * ex + py * ey;
        if (t <= 1e-12 * L2 || t >= (1 - 1e-12) * L2) continue;
        const cr = ex * py - ey * px;
        if (cr * cr <= 1e-14 * L2) return m;     // within 0.1 nm of the line
      }
      return -1;
    };
    const emit = (a, b, c) => {
      for (const [i, j, k] of [[a, b, c], [b, c, a], [c, a, b]]) {
        const m = onEdge(i, j);
        if (m >= 0) { emit(i, m, k); emit(m, j, k); return; }
      }
      down(ids[a], ids[b], ids[c]);
    };
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(outer, holes)) emit(a, b, c);
  };
  // The floor: a coarse ring 0.25 mm inside the edge ring (the letters stay
  // 0.5 mm inside it), zipped to the edge ring, then triangulated around the
  // letters. Earcut straight on the fine edge ring would clip ears of three
  // consecutive ring vertices: slivers whose ~0.01 um sagitta the 3MF's
  // 1 um rounding flattens or flips. The coarse ring's sagitta is ~5 um.
  const ring = [];
  for (let j = 0; j < SECT; j++) {
    const k = (ring0 + j) * 3;
    ring.push(new THREE.Vector2(pos[k], pos[k + 2]));
  }
  // viewer: the floor's own copy of the ring, so the recess wall's normals
  // don't smear into it (uneven fans along the ring shade as dashes)
  const ringIds = weld ? ring.map((_, j) => ring0 + j) : put(ring, rd);
  const ri = ring[0].length() - 0.25;
  const M = Math.min(SECT, Math.max(24, Math.floor(Math.PI * Math.sqrt(ri / 0.01))));
  const inner = [];
  for (let i = 0; i < M; i++) {
    const a = (i / M) * Math.PI * 2;
    inner.push(new THREE.Vector2(ri * Math.cos(a), ri * Math.sin(a)));
  }
  const innerIds = put(inner, rd);
  for (let i = 0, j = 0; i < M || j < SECT; ) {    // zip by angle; both start at 0
    if (j < SECT && (i >= M || (j + 1) * M <= (i + 1) * SECT)) {
      down(ringIds[j], ringIds[(j + 1) % SECT], innerIds[i % M]);
      j++;
    } else {
      down(ringIds[j % SECT], innerIds[(i + 1) % M], innerIds[i]);
      i++;
    }
  }
  const outerLetters = txt.contours.filter((c) => c.depth === 0);
  fill(inner, innerIds, outerLetters.map((c) => c.pts), outerLetters.map((c) => c.floorIds), true);
  for (const c of txt.contours) {
    const kids = c.children;
    if (c.solid)   // letter face, with its counters cut out
      fill(c.pts, c.faceIds, kids.map((o) => o.pts), kids.map((o) => o.faceIds));
    else           // floor inside a counter, around any letter part in it (the 0's dot)
      fill(c.pts, c.floorIds, kids.map((o) => o.pts), kids.map((o) => o.floorIds));
  }
  for (const c of txt.contours) {
    const top = weld ? c.floorIds : put(c.pts, rd);
    const bot = weld ? c.faceIds : put(c.pts, TEXT_CLEAR);
    const n = c.pts.length;
    for (let i = 0; i < n; i++) {
      // letter on the left of p -> q: (p_top, q_top, q_bot) faces outward
      const j = (i + 1) % n;
      idx.push(top[i], bot[j], top[j], top[i], bot[i], bot[j]);
    }
  }
}

// Records saved before the mark option had qr_enabled (always true in
// practice): map it onto mark, so restoring an old record rebuilds exactly
// what was printed (its QR), and drop the stale key.
function migrateBaseOpts(bo) {
  const o = { ...(bo || {}) };
  if ("qr_enabled" in o) {
    if (!("mark" in o)) o.mark = o.qr_enabled ? "qr" : "none";
    delete o.qr_enabled;
  }
  return o;
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
  // bottom: flat fan normally; with QR and/or recess, rings at the QR grid
  // (dense enough for the debossed modules) and at the recess wall edges,
  // then out to the rim. QR depth is measured from the recess floor. The
  // raised code replaces the centre fan with a floor meshed around it.
  const qr = BASE_OPTS.mark === "qr" ? (activeQR || placeholderQR()) : null;
  const qrSide = 0.62 * D;
  const qrDepth = BASE_OPTS.qr_depth_mm;
  const rd = recessDepth();
  const rIn = recessInnerRadius(D, rd);
  const txt = BASE_OPTS.mark === "text" ? textMarkLayout(D, rd) : null;
  const botY = (x, z) => Math.min(rd, Math.max(0, rIn - Math.hypot(x, z)))
    + (qr ? qrDepthAt(x, z, qr, qrSide, qrDepth) : 0);
  let botRings = [];                 // vertex index of each bottom ring
  const botCenter = pos.length / 3;
  if (!txt) pos.push(0, botY(0, 0), 0);
  for (const r of bottomRingRadii(D, ppm, !!qr, rd)) {
    botRings.push(pos.length / 3);
    for (let j = 0; j < SECT; j++) {
      const a = (j / SECT) * Math.PI * 2;
      const x = r * Math.cos(a), z = r * Math.sin(a);
      pos.push(x, botY(x, z), z);
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
  if (txt) addTextMark(pos, idx, txt, botRings[0], SECT, rd, weld);
  else for (let j = 0; j < SECT; j++)                   // bottom center fan
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

function insidePoly(poly, v) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a.y > v.y) !== (b.y > v.y)
        && v.x < ((b.x - a.x) * (v.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

// Sutherland-Hodgman against one half-plane: keep where f(p) >= 0 (f linear).
// Fine for our tab outline, which crosses each clip line exactly twice.
function clipHalfPlane(poly, f) {
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const fa = f(a), fb = f(b);
    if (fa >= 0) out.push(a);
    if ((fa >= 0) !== (fb >= 0)) {
      const t = fa / (fa - fb);
      out.push(new THREE.Vector2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t));
    }
  }
  return out.filter((p, i) => p.distanceTo(out[(i + 1) % out.length]) > 1e-9);
}

function supportUnder() {
  return !!(BASE_OPTS.support_perf && BASE_OPTS.support_under);
}

// Where the support blade sits across the disc's thickness (local y).
// Rim teeth: in the bottom slab's plane, [0, tf]. Teeth under the base: the
// whole support stepped back by its own thickness, less a small overlap so
// the lengthened teeth sink into the underside and fuse: [-tf + ov, ov].
const UNDER_OVERLAP = 0.1;
function bladeY() {
  const tf = BASE_OPTS.support_thickness_mm;
  return supportUnder() ? [-tf + UNDER_OVERLAP, UNDER_OVERLAP] : [0, tf];
}

// Raft placement across the disc's thickness (local y), shared by the
// support builder and the stack layout: centred on the disc's
// mid-thickness, but never so high that its lower face leaves the blade
// (>= 0.1 mm into it).
function raftLayout() {
  const tf = BASE_OPTS.support_thickness_mm;
  const raftT = Math.max(BASE_OPTS.support_raft_mm, tf + 0.3);
  const [b0, b1] = bladeY();
  const cy = Math.min(BASE_OPTS.base_height / 2, b1 - 0.1 + raftT / 2);
  return { raftT, cy, yMin: Math.min(b0, cy - raftT / 2) };
}

function buildSupportGeometries(base) {
  // Thin tab flush with the base's bottom face, coming off the rim
  // sideways (+x) as viewed here; parts print rotated 90° (disc on edge,
  // tab down). The tab hugs a full 180° of the rim, then sweeps to a
  // straight line at the plate. A thicker raft box sits on the plate.
  //
  // Interface to the disc, two modes:
  //  - solid (support_perf off): the inner arc sits 0.5 mm inside the
  //    rim -- one continuous weld of tf x half the circumference
  //    (~16 mm^2 on a 25 mm base). Strong, but a long seam to cut.
  //  - perforated: the tab stops perf_gap_mm short of the rim and reaches
  //    it only through a row of teeth, each necking down at 45° to a
  //    perf_contact_mm-wide contact at the rim, so it snaps there like a
  //    stamp perforation. A tooth always sits at angle 0 -- the rim's
  //    lowest point in print orientation, i.e. the disc's first layer,
  //    which must never start as an unsupported island.
  //  - teeth under the base (support_under, perforated only): the whole
  //    support steps back by its own thickness and the same teeth run on
  //    in under the base, bonding to the underside's foot ring instead of
  //    the rim edge -- the stubs sand off the bottom face.
  const Rb = base.diameter / 2;
  const tf = BASE_OPTS.support_thickness_mm;   // plate thickness (local y)
  const S = BASE_OPTS.support_height_mm;       // rim -> build plate distance
  const L = Math.min(BASE_OPTS.support_base_mm, 2 * Rb) / 2;
  const perf = !!BASE_OPTS.support_perf;
  const gap = BASE_OPTS.perf_gap_mm;
  const Ri = perf ? Rb + gap : Rb - 0.5;       // tab inner edge
  const cz = perf ? Ri + 1.05 : Rb + 0.55;     // bezier control, 1.05 past Ri
  const xB = Rb + S;

  // outline sampled manually (no duplicate seam points -> clean mesh):
  // 180° inner edge, bezier out to the bottom line, across the line,
  // bezier back up to the edge start
  const NA = 60, NB = 26;
  const P = (r, a) => new THREE.Vector2(r * Math.cos(a), r * Math.sin(a));
  const quad = (x0, y0, cx, cy, x1, y1, t) => new THREE.Vector2(
    (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * cx + t * t * x1,
    (1 - t) * (1 - t) * y0 + 2 * (1 - t) * t * cy + t * t * y1);
  const outer = [];
  for (let k = 1; k <= NB; k++) {   // (0,-Ri) -> (xB,-L), bulging past rim
    outer.push(quad(0, -Ri, Rb * 0.88, -cz, xB, -L, k / NB));
  }
  outer.push(new THREE.Vector2(xB, L));  // across the bottom line
  for (let k = 1; k < NB; k++) {    // (xB,+L) -> (0,+Ri), mirrored; stops
    outer.push(quad(xB, L, Rb * 0.88, cz, 0, Ri, k / NB));
  }                                 // short of the edge start (auto-close)

  const arc = (a0, a1) => {         // inner edge from a0 down to a1, ends incl.
    const n = Math.max(1, Math.ceil(((a0 - a1) / Math.PI) * NA));
    const out = [];
    for (let k = 0; k <= n; k++) out.push(P(Ri, a0 - (k / n) * (a0 - a1)));
    return out;
  };
  const edge = [];
  const toothAngles = [];
  let teeth = 0;
  let trimA = Math.PI / 2;           // perforated: sheet ends just past the last tooth
  if (!perf) {
    for (let k = 0; k <= NA; k++) edge.push(P(Ri, Math.PI / 2 - (k / NA) * Math.PI));
  } else {
    const wt = BASE_OPTS.perf_contact_mm;
    const wb = wt + 2 * gap;                   // 45° neck flanks
    const pitch = Math.max(BASE_OPTS.perf_pitch_mm, wb + 0.3);
    // tooth tips: 0.3 mm into the rim -- or, with teeth under the base,
    // running on in under the outer (foot) ring, bonding to the underside
    // over the same area as a rim contact (contact width x sheet thickness)
    const ext = !BASE_OPTS.support_under ? 0.3
      : recessDepth() > 0 ? Math.min(tf, Math.max(0.2, BASE_OPTS.foot_ring_mm - 0.1)) : tf;
    const Rc = Rb - ext;
    const dA = pitch / Rb;                     // spacing measured along the rim
    const aB = wb / 2 / Ri;                    // tooth half-angle at its root
    // only keep teeth rooted in solid tab: it thins to nothing toward ±90°
    // where the inner edge meets the outer bezier
    const plain = [...arc(Math.PI / 2, -Math.PI / 2), ...outer];
    const root = Ri + 0.6;
    const kMax = Math.floor(Math.PI / 2 / dA);
    let cur = Math.PI / 2, reach = 0;
    for (let k = kMax; k >= -kMax; k--) {
      const a = k * dA;
      if (a + aB >= Math.PI / 2 || a - aB <= -Math.PI / 2) continue;
      if (!insidePoly(plain, P(root, a + aB)) || !insidePoly(plain, P(root, a - aB))) continue;
      edge.push(...arc(cur, a + aB));
      edge.push(P(Rb, a + wt / 2 / Rb), P(Rc, a + wt / 2 / Rc),
                P(Rc, a - wt / 2 / Rc), P(Rb, a - wt / 2 / Rb));
      cur = a - aB;
      teeth++;
      toothAngles.push(a);
      reach = Math.max(reach, Math.abs(a));
    }
    edge.push(...arc(cur, -Math.PI / 2));
    if (teeth) trimA = Math.min(Math.PI / 2, reach + aB + 1.0 / Ri);   // 1 mm shoulder
  }
  let pts = [...edge, ...outer];
  if (perf && trimA < Math.PI / 2) {
    // the sheet past the outermost tooth never touches the disc -- trim it
    // to the wedge |angle| <= trimA instead of running on to the 90° cusps
    const c = Math.cos(trimA), s = Math.sin(trimA);
    pts = clipHalfPlane(pts, (p) => s * p.x - c * p.y);     // below the +trimA ray
    pts = clipHalfPlane(pts, (p) => s * p.x + c * p.y);     // above the -trimA ray
  }
  const tab = new THREE.ExtrudeGeometry(new THREE.Shape(pts), {
    depth: tf, bevelEnabled: false,
  });
  // extrude space (sx, sy, sz) -> base-local (x=sx, y=sz + y0, z=-sy);
  // determinant +1, so face winding is preserved
  const [y0] = bladeY();
  const p = tab.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const sx = p.getX(i), sy = p.getY(i), sz = p.getZ(i);
    p.setXYZ(i, sx, sz + y0, -sy);
  }
  tab.computeVertexNormals();
  tab.userData.teeth = teeth;

  const { raftT, cy } = raftLayout();
  // raft: thickness raftT (slider), 2 mm tall off the plate, exactly the
  // base width long (2L clamps to the disc diameter at the default
  // support_base_mm). Centered on the disc's mid-thickness (base_height/2),
  // not the thin tab, so on the plate it sits symmetrically under the
  // on-edge disc instead of sticking out one side.
  //
  // Clearance guard: the disc rim sits S (support height) off the plate
  // and the raft rises raftH, so their gap is S - raftH. Only the thin
  // snap-off tab may bridge them — keep >= 0.2 mm of air so the raft can
  // never fuse to the base, shrinking the raft if the support is short.
  // With perforation the raft also stays out of the breakaway gap, so it
  // can never swallow a tooth's neck.
  const RAFT_CLEAR = perf ? Math.max(0.2, gap) : 0.2;
  const raftH = Math.max(0.6, Math.min(2.0, S - RAFT_CLEAR));
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
  updateRecessNote();
  updateMarkNote();
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
      const { raftT, cy, yMin } = raftLayout();
      let cursor = 0;
      return bases.map((b) => {
        // unit extent along the thin (local y) axis: disc slab + relief
        // peak on one side, raft (and an under-base sheet) on the other
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

// Exact triangle count of an export (mirrors buildBaseGeometry's ring /
// sector / QR-bottom formulas) and rough peak browser memory per format:
// retained geometry ~24 B/tri; STL adds its 50 B/tri buffer plus the Blob
// copy; 3MF holds only ~9.5 B/tri of compressed output (plus its copy).
// The largest base's transient build arrays add ~36 B/tri on top.
const EXPORT_MEM_BUDGET = 3e9;
function exportEstimate(bases, ppm) {
  let tris = 0, maxBase = 0;
  for (const b of bases || []) {
    const D = b.diameter, Rb = D / 2;
    const rings = Math.min(Math.max(Math.round(Rb * ppm * 1.2), 32), 8192);
    const sect = Math.min(Math.max(Math.round(Math.PI * D * ppm * 1.2), 96), 32768);
    let t = sect + 2 * sect * (rings - 1) + 2 * sect;          // top + wall
    // bottom: centre fan + one quad band per ring (QR grid, recess wall);
    // the raised code adds a few hundred (an upper bound: earcut's exact
    // count depends on the letters)
    const rd = recessDepth();
    t += sect + 2 * sect * bottomRingRadii(D, ppm, BASE_OPTS.mark === "qr", rd).length;
    if (BASE_OPTS.mark === "text" && rd >= TEXT_MIN_RECESS - 1e-9) t += textMarkTris();
    tris += t;
    maxBase = Math.max(maxBase, t);
  }
  return {
    tris,
    stlBytes: 84 + 50 * tris,
    mf3Bytes: 9.5 * tris,
    peakStl: 124 * tris + 36 * maxBase,
    peak3mf: 43 * tris + 36 * maxBase,
  };
}

async function doExport(kind) {
  if (!lastBases || !lastBases.length) return;
  const est = exportEstimate(lastBases, BASE_OPTS.export_px_per_mm);
  const peak = kind === "3mf" ? est.peak3mf : est.peakStl;
  if (peak > EXPORT_MEM_BUDGET && !confirm(
      `This ${kind.toUpperCase()} export is ~${(est.tris / 1e6).toFixed(0)} M triangles ` +
      `and needs roughly ${(peak / 1e9).toFixed(1)} GB of browser memory — ` +
      `the tab will probably crash.\n\nLower "Download res" or export fewer bases ` +
      `per file` + (kind === "stl" ? ` (or use Export 3MF: about a third of the memory)` : "") +
      `.\n\nTry anyway?`)) return;
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
  // mint the export record FIRST so its code can be baked into the mark
  const placeSeed0 = parseInt($("bases-seed").value) || 1;
  const record = {
    base_opts: { ...BASE_OPTS },
    placement_seed: placeSeed0,
    terrain: { seed: state.seed, config: state.config },
  };
  let guid = null, minted = null;
  if (window.__reuse_guid) {
    // re-export of an existing record (scripts/reexport.py): keep the
    // original code so the mark, filename and /b/ link stay unchanged
    guid = window.__reuse_guid;
    try {
      const r = await fetch(`/api/exports/${encodeURIComponent(guid)}`);
      const rec = await r.json();
      if (rec.guid) guid = rec.guid;      // canonical form of a typed code
      minted = { guid, schema: rec.schema,
                 generator_commit: rec.current_generator_commit };
    } catch (e) { minted = { guid, schema: 1, generator_commit: "reexport" }; }
  } else try {
    const r = await fetch("/api/log_export", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(record),
    });
    if (r.ok) { minted = await r.json(); guid = minted.guid; }
  } catch (e) { /* offline: export continues with the placeholder mark */ }

  btn.textContent = "Building mesh…";
  btn.disabled = true;
  // yield one frame so the label paints before the heavy synchronous meshing
  await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
  try {
    activeQR = guid && BASE_OPTS.mark === "qr" ? qrEncode(`${QR_CANONICAL}/b/${guid}`) : null;
    activeCode = guid;
    if (kind === "3mf") await export3MFGeos(hbases, record, minted);
    else exportSTLGeos(hbases, record, guid);
  } finally {
    activeQR = null;
    activeCode = null;
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

// Indexed mesh + print transform for the 3MF writer. Welds soup meshes
// (ExtrudeGeometry tab) AND small indexed ones whose faces don't share
// vertices (BoxGeometry raft = 6 disconnected quads with 24 open edges by
// index); the disc grids are already welded.
function prepMesh(g, map) {
  let positions = g.attributes.position.array;
  let index = g.index ? g.index.array : null;
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
  return { positions, index, map };
}

async function export3MFGeos(hbases, record, minted) {
  const geos = baseGeometries(1.0, hbases, { rings: 8192, sect: 32768 }, true);
  const printMode = BASE_OPTS.support_enabled;
  const stacked = BASE_OPTS.stack_enabled;
  const pitch = Math.max(BASE_OPTS.d_small, BASE_OPTS.d_large) + 8;
  const guid = minted ? minted.guid : null;
  const meshes = geos.map(({ g, off, base, i }) =>
    prepMesh(g, geoMap(off, base, i, hbases.length, printMode, stacked, pitch)));
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

// ---------------------------------------------------------------- support sweep
//
// One plate of identical bases (same terrain crop, same size) whose
// supports range from sure things to likely failures, so a single print
// shows where the contacts start to fail. Resin print time depends on
// height, not part count, so the extra bases only cost resin. Columns
// step the contact width down; row A uses the default tooth spacing and
// row B a sparser one; A0 is the old solid weld as a control. Every base
// gets its own export record, so the code on its bottom names its exact
// variant.
const SWEEP_WIDTHS = [1.0, 0.7, 0.5, 0.35, 0.25, 0.15];   // sure -> likely fail
const SWEEP_ROWS = [   // [row, tooth spacing, teeth under the base?]
  ["A", 2.5, false], ["B", 4.0, false], ["C", 2.5, true]];

function sweepVariants() {
  const out = [{ label: "A0", row: 0, col: 0, perf: false, under: false }];
  SWEEP_ROWS.forEach(([name, pitch, under], r) => SWEEP_WIDTHS.forEach((contact, c) =>
    out.push({ label: name + (c + 1), row: r, col: c + 1, perf: true, contact, pitch, under })));
  return out;
}

function downloadBlob(parts, type, name) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(parts, { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

function sweepLegend(id, variants, base, ppm, placement) {
  const t = BASE_OPTS.support_thickness_mm, gap = BASE_OPTS.perf_gap_mm;
  const area = (v) => v.perf ? v.teeth * v.contact * t : (Math.PI * base.diameter / 2) * t;
  const row = (cells) => cells.map((c, i) => String(c).padEnd([6, 12, 9, 9, 7, 11][i] || 0)).join("");
  const lines = [
    `Support sweep ${id}: ${variants.length} identical Ø${base.diameter} mm bases, ` +
      `${ppm} px/mm, terrain seed ${state.seed}, placement seed ${placement}`,
    `Support sheet ${t} mm thick, breakaway gap ${gap} mm (both fixed; only the contacts vary).`,
    "",
    "Plate layout: each row is a rack of discs side by side; column number",
    "increases along the rack, rows A, B, C sit side by side along the rafts' length.",
    "  A0     solid weld (the old design) - the control",
    `  A1-A6  teeth on the rim every 2.5 mm, contact width ${SWEEP_WIDTHS.join(" / ")} mm`,
    "  B1-B6  same widths, teeth every 4 mm (sparser)",
    "  C1-C6  same widths every 2.5 mm, teeth UNDER the base (sand the bottom flat)",
    "Left to right is sure thing -> likely failure. The code on each base's",
    "bottom (the last column) leads to its exact settings, so the bases can",
    "be told apart after they come off.",
    "",
    row(["base", "support", "width", "spacing", "teeth", "contact"]) + "code   record",
  ];
  for (const v of variants) {
    lines.push(row([
      v.label, !v.perf ? "solid weld" : v.under ? "under base" : "rim teeth",
      v.perf ? `${v.contact} mm` : "-", v.perf ? `${v.pitch} mm` : "-",
      v.perf ? v.teeth : "-", `${area(v).toFixed(2)} mm2`,
    ]) + `${v.guid.padEnd(7)}${QR_CANONICAL}/b/${v.guid}`);
  }
  lines.push("",
    "Reading it: the best setting is usually the narrowest contact that held",
    "and still snapped off cleanly, plus one step back toward the sure end",
    "for margin. If a whole row failed, spacing matters more than width.",
    "Row C vs row A: same contacts, teeth on the underside vs the rim edge.",
    "After printing, check the vat film: a base that tore off mid-print can",
    "leave cured resin stuck to it.");
  return lines.join("\n") + "\n";
}

async function exportSupportSweep() {
  if (!state.key) return;
  const btn = $("bases-sweep");
  const label0 = btn.textContent;
  // terrain detail doesn't matter for a support test; cap it to keep the
  // plate small (13 bases at 16 px/mm is ~17 M triangles)
  const ppm = Math.min(BASE_OPTS.export_px_per_mm, 16);
  const variants = sweepVariants();
  const est = exportEstimate(variants.map(() => ({ diameter: BASE_OPTS.d_small })), ppm);
  if (est.peak3mf > EXPORT_MEM_BUDGET && !confirm(
      `This sweep is ~${(est.tris / 1e6).toFixed(0)} M triangles and needs roughly ` +
      `${(est.peak3mf / 1e9).toFixed(1)} GB of browser memory. Lower "Download res" or ` +
      `"Small Ø".\n\nTry anyway?`)) return;
  btn.disabled = true;
  btn.textContent = "Rendering sweep…";
  try {
    const bases = await requestBases(ppm, { count: 1, large_fraction: 0 });
    if (!bases || !bases.length) throw new Error("couldn't fetch the base");
    const base = bases[0];
    const placement = parseInt($("bases-seed").value) || 1;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(4)),
      (b) => b.toString(16).padStart(2, "0")).join("");
    for (const v of variants) {
      v.opts = {
        ...BASE_OPTS, count: 1, large_fraction: 0, support_enabled: true,
        stack_enabled: false, support_perf: v.perf, support_under: v.under,
        ...(v.perf ? { perf_contact_mm: v.contact, perf_pitch_mm: v.pitch } : {}),
      };
      const r = await fetch("/api/log_export", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          base_opts: v.opts, placement_seed: placement,
          terrain: { seed: state.seed, config: state.config },
          sweep: { id, label: v.label, variants: variants.length, px_per_mm: ppm },
        }),
      });
      if (!r.ok) throw new Error("couldn't store the export records");
      v.guid = (await r.json()).guid;
    }

    btn.textContent = "Building sweep…";
    await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    const saved = { ...BASE_OPTS };
    const meshes = [], built = [];
    const colPitch = Math.ceil(BASE_OPTS.base_height + (base.max - base.mean) + 7);
    const rowPitch = base.diameter + 10;
    try {
      for (const v of variants) {
        Object.assign(BASE_OPTS, v.opts);
        activeQR = BASE_OPTS.mark === "qr" ? qrEncode(`${QR_CANONICAL}/b/${v.guid}`) : null;
        activeCode = v.guid;
        // print orientation (disc on edge, raft on the plate), laid out on
        // a grid: row -> along the raft length, column -> along the rack
        const zTop = base.diameter / 2 + BASE_OPTS.support_height_mm;
        const X0 = v.row * rowPitch, Y0 = v.col * colPitch;
        const map = (x, y, z) => [z + X0, y + Y0, zTop - x];
        const disc = buildBaseGeometry(base, 0, 1.0, { rings: 8192, sect: 32768 }, true);
        const support = buildSupportGeometries(base);      // sheet, raft (+ teeth when under the base)
        v.teeth = support[0].userData.teeth;
        for (const g of [disc, ...support]) { meshes.push(prepMesh(g, map)); built.push(g); }
      }
    } finally {
      Object.assign(BASE_OPTS, saved);
      activeQR = null;
      activeCode = null;
    }
    const chunks = await build3MF(meshes, {
      Application: "Battlefield Heightmap Studio",
      Title: `support sweep ${id}`,
      "hms:sweep": JSON.stringify(variants.map((v) => ({
        label: v.label, guid: v.guid, perforated: v.perf, under: v.under, contact_mm: v.contact ?? null,
        pitch_mm: v.pitch ?? null, teeth: v.teeth }))),
    });
    built.forEach((g) => g.dispose());
    downloadBlob(chunks, "application/vnd.ms-package.3dmanufacturing-3dmodel+xml",
      `support_sweep_${id}.3mf`);
    downloadBlob([sweepLegend(id, variants, base, ppm, placement)], "text/plain",
      `support_sweep_${id}.txt`);
  } catch (e) {
    console.error("support sweep failed:", e);
    alert(`Support sweep failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = label0;
  }
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
const basesSelects = {};    // key -> select element

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

function addSelect(wrap, key, label, options) {
  const row = document.createElement("div");
  row.className = "row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const sel = document.createElement("select");
  for (const [value, text] of options) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = text;
    sel.appendChild(o);
  }
  sel.value = BASE_OPTS[key];
  sel.addEventListener("change", () => {
    BASE_OPTS[key] = sel.value;
    updateMarkNote();
    scheduleMeshes();
  });
  row.append(lab, sel);
  basesSelects[key] = sel;
  wrap.appendChild(row);
}

function syncBaseControls() {
  for (const { key, row } of basesRows) row._sync(BASE_OPTS[key]);
  for (const [key, chk] of Object.entries(basesChecks)) chk.checked = !!BASE_OPTS[key];
  for (const [key, sel] of Object.entries(basesSelects)) sel.value = BASE_OPTS[key];
  updateMarkNote();
}

// "Find a base": look up the code read off a base bottom (or a pasted
// /b/ link) and offer its record page and a restore. The server does the
// forgiving parse and the check character. Records are client-supplied,
// so everything shown goes in as text, never markup.
async function findBase() {
  const out = $("find-result");
  const raw = $("find-code").value.trim()
    .replace(/^.*(\/b\/|restore=)/, "").replace(/[/?#&].*$/, "");
  if (!raw) return;
  out.hidden = false;
  out.textContent = "Looking up…";
  let rec;
  try {
    const r = await fetch(`/api/exports/${encodeURIComponent(raw)}`);
    rec = await r.json();
    if (!r.ok) {
      out.textContent = typeof rec.detail === "string" ? rec.detail : `Lookup failed (HTTP ${r.status}).`;
      return;
    }
  } catch (e) {
    out.textContent = "Lookup failed: the server didn't answer.";
    return;
  }
  const bo = rec.base_opts || {};
  const facts = [
    rec.ts ? `exported ${String(rec.ts).replace("T", " ").replace("+00:00", " UTC")}` : null,
    rec.sweep ? `support sweep base ${rec.sweep.label}`
      : bo.count ? `${bo.count} base${bo.count === 1 ? "" : "s"}` : null,
    rec.terrain ? `terrain seed ${rec.terrain.seed}` : null,
    rec.placement_seed != null ? `placement seed ${rec.placement_seed}` : null,
    rec.reproducible_exactly ? null : `made by an older version (${rec.generator_commit})`,
  ].filter(Boolean);
  const head = document.createElement("b");
  head.textContent = rec.guid;
  const link = (href, text, newTab) => {
    const a = document.createElement("a");
    a.href = href;
    a.textContent = text;
    if (newTab) a.target = "_blank";
    return a;
  };
  out.replaceChildren(head, ` · ${facts.join(" · ")} · `,
    link(`/b/${encodeURIComponent(rec.guid)}`, "record", true), " · ",
    link(`/?restore=${encodeURIComponent(rec.guid)}`, "restore this setup"));
}

function initBases() {
  const wrap = $("bases-controls");
  addBaseSliders(wrap, BASE_PARAMS);
  const recessNote = document.createElement("div");
  recessNote.className = "row";
  recessNote.style.fontSize = "11px";
  recessNote.style.opacity = "0.75";
  wrap.appendChild(recessNote);
  updateRecessNote = () => {
    const got = recessDepth();
    recessNote.textContent = BASE_OPTS.recess_mm > got + 1e-9
      ? `Bottom recess capped at ${got.toFixed(2)} mm to keep 0.6 mm under the pin sockets.`
      : "";
    recessNote.hidden = !recessNote.textContent;
  };
  updateRecessNote();

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
  addToggle(wrap, "support_perf", "Perforated breakaway (contact teeth)");
  addToggle(wrap, "support_under", "Teeth under the base (sand off)");
  addBaseSliders(wrap, PERF_PARAMS);

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
  addSelect(wrap, "mark", "Bottom mark", [
    ["text", "Code (raised letters)"], ["qr", "QR code (debossed)"], ["none", "None"]]);
  const markNote = document.createElement("div");
  markNote.className = "row";
  markNote.style.fontSize = "11px";
  markNote.style.opacity = "0.75";
  wrap.appendChild(markNote);
  updateMarkNote = () => {
    const rd = recessDepth();
    if (BASE_OPTS.mark === "text") {
      markNote.textContent = rd < TEXT_MIN_RECESS - 1e-9
        ? `⚠ No code will be printed: raised letters need a bottom recess of at ` +
          `least ${TEXT_MIN_RECESS} mm (now ${rd.toFixed(2)} mm` +
          (BASE_OPTS.recess_mm > rd + 1e-9 ? ", capped by the pin sockets" : "") + ")."
        : `Each export's own 6-character code, raised ${(rd - TEXT_CLEAR).toFixed(2)} mm ` +
          `on the recess floor and ${TEXT_CLEAR} mm short of the foot ring. The viewer ` +
          `shows ${TEXT_PLACEHOLDER}; the real code is baked in at download time. Look ` +
          `codes up below or at ${QR_CANONICAL.replace("https://", "")}/b/CODE.`;
    } else if (BASE_OPTS.mark === "qr") {
      markNote.textContent =
        `Debossed 45°-chamfered modules, ${BASE_OPTS.qr_depth_mm} mm deep — prints ` +
        "supportless; add a contrasting wash to scan. Viewer shows a placeholder; " +
        "the real per-export link is baked in at download time.";
    } else {
      markNote.textContent = "No mark. Each export still gets a record; its code is in the file name.";
    }
  };
  updateMarkNote();
  const expNote = document.createElement("div");
  expNote.className = "row";
  expNote.style.fontSize = "11px";
  expNote.style.opacity = "0.75";
  updateExportEst = () => {
    const ppm = BASE_OPTS.export_px_per_mm;
    const micron = Math.round(1000 / ppm);
    const e = exportEstimate(lastBases, ppm);
    const mb = (b) => `${(b / 1048576).toFixed(0)} MB`;
    expNote.textContent = e.tris
      ? `${micron} µm/px · ~${(e.tris / 1e6).toFixed(1)} M tris · ` +
        `STL ~${mb(e.stlBytes)} · 3MF ~${mb(e.mf3Bytes)}` +
        (e.peakStl > EXPORT_MEM_BUDGET
          ? (e.peak3mf > EXPORT_MEM_BUDGET
            ? "  ⚠ too big for the browser — lower res or fewer bases"
            : "  ⚠ too big as STL — use 3MF")
          : "")
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
  $("bases-sweep").addEventListener("click", exportSupportSweep);
  $("find-go").addEventListener("click", findBase);
  $("find-code").addEventListener("keydown", (e) => { if (e.key === "Enter") findBase(); });

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
    Object.assign(BASE_OPTS, migrateBaseOpts(data.base_opts));
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
