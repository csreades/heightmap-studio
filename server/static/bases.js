/* 3D base viewer (Bases tab): circular, mildly tapered LI bases cropped
   from the current domain. Uses globals from app.js: state, sliderRow, $. */
"use strict";

const BASE_OPTS = {
  count: 6, large_fraction: 0.35, d_small: 25, d_large: 32,
  base_height: 3.0, taper_mm: 1.5, px_per_mm: 5, exaggeration: 1.0,
  rim_lip_mm: 1.0,
  pins_enabled: false, pin_count: 4, pin_diameter_mm: 2.0,
  pin_depth_mm: 1.0, pin_ring_frac: 0.55, pin_noise: 0.0,
  support_enabled: false, support_height_mm: 4.0,
  support_thickness_mm: 0.8, support_base_mm: 8.0,
};
// [key, label, min, max, step, unit, refetch?]
const BASE_PARAMS = [
  ["count", "Base count", 1, 12, 1, "", true],
  ["large_fraction", "Large share", 0, 1, 0.05, "", true],
  ["d_small", "Small Ø", 10, 40, 0.5, "mm", true],
  ["d_large", "Large Ø", 15, 60, 0.5, "mm", true],
  ["px_per_mm", "Quality", 2, 10, 0.5, "px/mm", true],
  ["base_height", "Base height", 1, 6, 0.1, "mm"],
  ["taper_mm", "Side taper", -4, 4, 0.1, "mm"],  // + = narrower at top (LI style), - = narrower at bottom
  ["rim_lip_mm", "Edge lip", 0, 4, 0.1, "mm"],   // flat rim: bump map fades out before the edge
  ["exaggeration", "Relief view ×", 0.5, 4, 0.1, "x"],
];
const PIN_PARAMS = [
  ["pin_count", "Pin count", 2, 12, 1, ""],
  ["pin_diameter_mm", "Pin Ø", 0.5, 6, 0.1, "mm"],
  ["pin_depth_mm", "Pin depth", 0.2, 3, 0.05, "mm"],
  ["pin_ring_frac", "Ring radius", 0.1, 0.95, 0.01, "×R"],
  ["pin_noise", "Position noise", 0, 1, 0.02, ""],   // 1 = up to 1 mm XY error
];
const SUPPORT_PARAMS = [
  ["support_height_mm", "Height", 2, 12, 0.5, "mm"],
  ["support_thickness_mm", "Thickness", 0.4, 2.5, 0.05, "mm"],
  ["support_base_mm", "Base size", 2, 40, 0.5, "mm"],
];

let R3 = null;            // {renderer, scene, camera, controls, group}
let lastBases = null;
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

async function fetchBases() {
  if (!state.key) return;
  const res = await fetch("/api/bases", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: state.key,
      placement_seed: parseInt($("bases-seed").value) || 1,
      count: BASE_OPTS.count,
      large_fraction: BASE_OPTS.large_fraction,
      d_small: BASE_OPTS.d_small,
      d_large: BASE_OPTS.d_large,
      px_per_mm: BASE_OPTS.px_per_mm,
    }),
  });
  if (!res.ok) return;
  const data = await res.json();
  lastBases = data.bases.map((b) => {
    const bin = atob(b.heights_b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { ...b, heights: new Float32Array(bytes.buffer) };
  });
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

function buildBaseGeometry(base, baseIndex, exOverride) {
  const { heights, n, diameter: D, mean } = base;
  // LI bases are widest at the table and narrow toward the top surface:
  // nominal diameter D at the bottom, top pulled in by the taper
  const Rb = D / 2;                                    // bottom radius
  const Rt = Math.min(Math.max(Rb - BASE_OPTS.taper_mm, Rb * 0.4), Rb * 1.6);
  const H = BASE_OPTS.base_height;
  const ex = exOverride !== undefined ? exOverride : BASE_OPTS.exaggeration;
  // match mesh density to the height grid so the rim is as sharp as the
  // center (polar sector spacing grows with radius)
  const ppm = base.px_per_mm;
  const RINGS = Math.min(Math.max(Math.round((D / 2) * ppm * 1.2), 32), 160);
  const SECT = Math.min(Math.max(Math.round(Math.PI * D * ppm * 1.2), 96), 640);

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
    p.floor = Math.max(surf(p.x, p.z) - BASE_OPTS.pin_depth_mm, 0.15);
  }
  const topY = (x, z) => {
    let y = surf(x, z);
    for (const p of pins) {
      const dx = x - p.x, dz = z - p.z;
      if (dx * dx + dz * dz <= p.r * p.r) y = Math.min(y, p.floor);
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
  const wallTop = pos.length / 3;                      // duplicated rim (sharp edge)
  for (let j = 0; j < SECT; j++) {
    const k = (rimStart + j) * 3;
    pos.push(pos[k], pos[k + 1], pos[k + 2]);
  }
  const wallBot = pos.length / 3;
  for (let j = 0; j < SECT; j++) {
    const a = (j / SECT) * Math.PI * 2;
    pos.push(Rb * Math.cos(a), 0, Rb * Math.sin(a));
  }
  const botCenter = pos.length / 3;
  pos.push(0, 0, 0);

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
  for (let j = 0; j < SECT; j++)                        // bottom fan
    idx.push(botCenter, wallBot + ((j + 1) % SECT), wallBot + j);

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

function buildSupportGeometry(base) {
  // Thin tab flush with the base's bottom face, coming off the rim
  // sideways (+x) as viewed here. Parts print rotated 90° -- disc on
  // edge -- so the tab runs down to the build plate: its edge follows
  // the rim circle ("curves"), then sweeps in to a straight line of
  // length support_base_mm at support_height_mm beyond the rim.
  const Rb = base.diameter / 2;
  const tf = BASE_OPTS.support_thickness_mm;   // plate thickness (local y)
  const S = BASE_OPTS.support_height_mm;       // rim -> build plate distance
  const w0 = 0.65 * Rb;                        // half contact width at rim
  const L = Math.min(BASE_OPTS.support_base_mm / 2, w0); // half line length
  const xA = Math.sqrt(Math.max(Rb * Rb - w0 * w0, 0)) - 1.0; // embedded start
  const xB = Rb + S;
  const K = 36;

  const pos = [];
  for (let k = 0; k <= K; k++) {
    const u = k / K;
    const x = xA + (xB - xA) * u;
    let h = L + (w0 - L) * Math.pow(1 - u, 2.0);   // curve -> line
    if (x < Rb) {                                   // stay inside the rim
      h = Math.min(h, Math.sqrt(Math.max(Rb * Rb - x * x, 1e-6)));
    }
    // cross-section rectangle in (y, z) at this x
    pos.push(x, 0, h, x, tf, h, x, tf, -h, x, 0, -h);
  }
  const idx = [];
  const C = 4;
  for (let k = 0; k < K; k++) {
    const a = k * C, b = (k + 1) * C;
    for (let e = 0; e < C; e++) {
      const e1 = (e + 1) % C;
      idx.push(a + e, b + e, b + e1, a + e, b + e1, a + e1);
    }
  }
  idx.push(0, 1, 2, 0, 2, 3);                       // inner cap (-x, in base)
  const m = K * C;
  idx.push(m, m + 2, m + 1, m, m + 3, m + 2);       // outer cap (+x)

  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function baseGeometries(exOverride) {
  // all closed shells for the current bases (base + optional support tab)
  const offs = layoutOffsets(lastBases.length);
  const out = [];
  lastBases.forEach((b, i) => {
    out.push({ g: buildBaseGeometry(b, i, exOverride), off: offs[i], base: b, i });
    if (BASE_OPTS.support_enabled) {
      out.push({ g: buildSupportGeometry(b), off: offs[i], base: b, i });
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

  for (const { g, off } of baseGeometries()) {
    const mesh = new THREE.Mesh(g, mat);
    mesh.position.set(off[0], 0, off[1]);
    group.add(mesh);
  }
  R3.scene.add(group);
  R3.group = group;

  const stats = lastBases.map((b, i) =>
    `<div>#${i + 1} · Ø${b.diameter} mm · relief ${(b.max - b.min).toFixed(2)} mm ` +
    `· @(${b.x}, ${b.y}) rot ${b.rotation}°</div>`).join("");
  $("bases-stats").innerHTML = stats;
}

// ---------------------------------------------------------------- STL export

function layoutOffsets(count) {
  const perRow = Math.ceil(Math.sqrt(count));
  const pitch = Math.max(BASE_OPTS.d_small, BASE_OPTS.d_large) + 14;
  const rows = Math.ceil(count / perRow);
  return Array.from({ length: count }, (_, i) => {
    const r = Math.floor(i / perRow), c = i % perRow;
    return [(c - (perRow - 1) / 2) * pitch, (r - (rows - 1) / 2) * pitch];
  });
}

function exportSTL() {
  if (!lastBases || !lastBases.length) return;
  // print-true geometry: relief exaggeration forced to 1x
  const geos = baseGeometries(1.0);
  let tris = 0;
  for (const { g } of geos) tris += g.index.count / 3;

  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  let o = 84;
  // with supports on, export in PRINT orientation: discs on edge in a row,
  // tabs pointing down, every support line landing on z=0
  const printMode = BASE_OPTS.support_enabled;
  const pitch = Math.max(BASE_OPTS.d_small, BASE_OPTS.d_large) + 8;
  const nBases = lastBases.length;
  geos.forEach(({ g, off, base, i }) => {
    const p = g.attributes.position.array;
    const ix = g.index.array;
    const [ox, oz] = off;
    const rowX = (i - (nBases - 1) / 2) * pitch;
    const zTop = base.diameter / 2 + BASE_OPTS.support_height_mm;
    for (let k = 0; k < ix.length; k += 3) {
      // both maps have determinant +1 so the winding stays outward:
      //   flat:  (x, y, z) -> (x, -z, y)         (three.js y-up -> STL z-up)
      //   print: (x, y, z) -> (z + row, y, zTop - x)   (disc on edge)
      const v = [];
      for (let m = 0; m < 3; m++) {
        const a = ix[k + m] * 3;
        if (printMode) {
          v.push([p[a + 2] + rowX, p[a + 1], zTop - p[a]]);
        } else {
          v.push([p[a] + ox, -(p[a + 2] + oz), p[a + 1]]);
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

  const seed = parseInt($("bases-seed").value) || 1;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([buf], { type: "model/stl" }));
  a.download = `bases_seed${state.seed}_place${seed}.stl`;
  a.click();
  URL.revokeObjectURL(a.href);
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

function addBaseSliders(wrap, params) {
  for (const [key, label, min, max, step, unit, refetch] of params) {
    const row = sliderRow(label, BASE_OPTS[key], min, max, step, unit,
      (v) => {
        BASE_OPTS[key] = v;
        if (refetch) scheduleBases();
        else rebuildMeshes();     // local-only rebuild, no refetch
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
    rebuildMeshes();
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
  $("bases-reroll").addEventListener("click", () => {
    $("bases-seed").value = Math.floor(Math.random() * 1e6);
    fetchBases();
  });
  $("bases-seed").addEventListener("change", fetchBases);
  $("bases-generate").addEventListener("click", fetchBases);
  $("bases-export").addEventListener("click", exportSTL);

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
      if (!lastBases) fetchBases();
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
