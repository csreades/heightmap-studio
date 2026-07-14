/* 3D base viewer (Bases tab): circular, mildly tapered LI bases cropped
   from the current domain. Uses globals from app.js: state, sliderRow, $. */
"use strict";

const BASE_OPTS = {
  count: 6, large_fraction: 0.35, d_small: 25, d_large: 32,
  base_height: 3.0, taper_mm: 1.5, px_per_mm: 5, exaggeration: 1.0,
};
const BASE_PARAMS = [
  ["count", "Base count", 1, 12, 1, ""],
  ["large_fraction", "Large share", 0, 1, 0.05, ""],
  ["d_small", "Small Ø", 10, 40, 0.5, "mm"],
  ["d_large", "Large Ø", 15, 60, 0.5, "mm"],
  ["base_height", "Base height", 1, 6, 0.1, "mm"],
  ["taper_mm", "Side taper", -4, 4, 0.1, "mm"],  // + = narrower at top (LI style), - = narrower at bottom
  ["px_per_mm", "Quality", 2, 10, 0.5, "px/mm"],
  ["exaggeration", "Relief view ×", 0.5, 4, 0.1, "x"],
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

function buildBaseGeometry(base, exOverride) {
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
  const topY = (x, z) => H + (sampleGrid(heights, n, D, x, z) - mean) * ex;

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

  const offs = layoutOffsets(lastBases.length);
  lastBases.forEach((b, i) => {
    const mesh = new THREE.Mesh(buildBaseGeometry(b), mat);
    mesh.position.set(offs[i][0], 0, offs[i][1]);
    group.add(mesh);
  });
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
  const geos = lastBases.map((b) => buildBaseGeometry(b, 1.0));
  const offs = layoutOffsets(lastBases.length);
  let tris = 0;
  for (const g of geos) tris += g.index.count / 3;

  const buf = new ArrayBuffer(84 + tris * 50);
  const dv = new DataView(buf);
  dv.setUint32(80, tris, true);
  let o = 84;
  geos.forEach((g, gi) => {
    const p = g.attributes.position.array;
    const ix = g.index.array;
    const [ox, oz] = offs[gi];
    for (let k = 0; k < ix.length; k += 3) {
      // three.js y-up -> STL z-up (mm): (x, y, z) -> (x, -z, y);
      // this map has determinant +1 so the winding stays outward
      const v = [];
      for (let m = 0; m < 3; m++) {
        const a = ix[k + m] * 3;
        v.push([p[a] + ox, -(p[a + 2] + oz), p[a + 1]]);
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

// ---------------------------------------------------------------- wiring

function initBases() {
  const wrap = $("bases-controls");
  for (const [key, label, min, max, step, unit] of BASE_PARAMS) {
    wrap.appendChild(sliderRow(label, BASE_OPTS[key], min, max, step, unit,
      (v) => {
        BASE_OPTS[key] = v;
        if (["base_height", "taper_mm", "exaggeration"].includes(key)) {
          rebuildMeshes();          // local-only rebuild, no refetch
        } else {
          scheduleBases();
        }
      }));
  }
  $("bases-reroll").addEventListener("click", () => {
    $("bases-seed").value = Math.floor(Math.random() * 1e6);
    fetchBases();
  });
  $("bases-seed").addEventListener("change", fetchBases);
  $("bases-generate").addEventListener("click", fetchBases);
  $("bases-export").addEventListener("click", exportSTL);

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
