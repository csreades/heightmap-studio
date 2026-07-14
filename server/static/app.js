/* Battlefield Heightmap Studio viewer */
"use strict";

// ---------------------------------------------------------------- schema

// [path, label, min, max, step, unit]
const GLOBAL_PARAMS = [
  ["master_amplitude", "Master amplitude", 0.1, 3.0, 0.05, "x"],
  ["px_per_mm", "Crop px/mm", 2, 32, 1, "px"],
];

const LAYER_PARAMS = {
  ground: [
    ["scale_mm", "Macro scale", 10, 250, 1, "mm"],
    ["amplitude_mm", "Amplitude", 0, 1.5, 0.01, "mm"],
    ["octaves", "Octaves", 1, 8, 1, ""],
    ["lacunarity", "Lacunarity", 1.5, 3.0, 0.05, ""],
    ["gain", "Gain", 0.2, 0.8, 0.01, ""],
    ["roughness_amplitude_mm", "Roughness amp", 0, 0.3, 0.005, "mm"],
    ["roughness_scale_mm", "Roughness scale", 0.3, 6, 0.05, "mm"],
  ],
  cracks: [
    ["cell_mm", "Cell size", 2, 25, 0.25, "mm"],
    ["width_mm", "Crack width", 0.05, 2.5, 0.05, "mm"],
    ["depth_mm", "Crack depth", 0, 1, 0.01, "mm"],
    ["falloff", "Edge falloff", 0.4, 4, 0.05, ""],
    ["jitter", "Cell jitter", 0, 1, 0.02, ""],
    ["warp_mm", "Warp", 0, 8, 0.1, "mm"],
    ["source_tile_mm", "Source tile size", 10, 150, 1, "mm"],
  ],
  craters: [
    ["spacing_mm", "Spawn spacing", 10, 120, 1, "mm"],
    ["probability", "Density", 0, 1, 0.02, ""],
    ["min_radius_mm", "Min radius", 0.5, 8, 0.1, "mm"],
    ["max_radius_mm", "Max radius", 2, 20, 0.25, "mm"],
    ["depth_per_radius", "Depth / radius", 0, 0.3, 0.005, ""],
    ["rim_height_rel", "Rim height", 0, 1.5, 0.02, ""],
    ["rim_width_rel", "Rim width", 0.04, 0.5, 0.01, ""],
    ["ejecta_falloff", "Ejecta falloff", 0.05, 1.5, 0.05, ""],
    ["source_mix", "Sourced stamp mix", 0, 1, 0.05, ""],
    ["crack_clearing", "Crack clearing", 0, 1, 0.05, ""],
  ],
  plates: [
    ["tile_mm", "Tile size", 5, 60, 0.5, "mm"],
    ["rotation_deg", "Grid rotation", 0, 90, 1, "°"],
    ["coverage", "Coverage", 0, 1, 0.02, ""],
    ["patch_scale_mm", "Patch scale", 40, 400, 5, "mm"],
    ["missing_probability", "Missing tiles", 0, 0.6, 0.02, ""],
    ["joint_width_mm", "Joint width", 0.1, 3, 0.05, "mm"],
    ["bevel_mm", "Edge bevel", 0.05, 2, 0.05, "mm"],
    ["plate_height_mm", "Plate lift", 0, 0.5, 0.01, "mm"],
    ["height_var_mm", "Lift variance", 0, 0.2, 0.005, "mm"],
    ["tilt_mm", "Tile tilt", 0, 0.3, 0.005, "mm"],
    ["broken_probability", "Broken tiles", 0, 1, 0.02, ""],
    ["crack_depth_mm", "Crack depth", 0, 0.5, 0.01, "mm"],
    ["crack_cell_mm", "Crack cell", 1.5, 15, 0.25, "mm"],
    ["crack_width_mm", "Crack width", 0.1, 1.5, 0.05, "mm"],
  ],
  roads: [
    ["spacing_mm", "Network spacing", 60, 500, 5, "mm"],
    ["edge_probability", "Density", 0, 1, 0.02, ""],
    ["junction_probability", "Junctions", 0, 1, 0.02, ""],
    ["width_mm", "Road width", 2, 30, 0.5, "mm"],
    ["offset_mm", "Corridor offset", -0.5, 0.2, 0.01, "mm"],
    ["shoulder_mm", "Shoulder", 0.5, 8, 0.1, "mm"],
    ["wobble", "Winding", 0, 0.8, 0.02, ""],
    ["berm_height_mm", "Berm height", 0, 0.4, 0.005, "mm"],
    ["berm_width_mm", "Berm width", 0.3, 4, 0.05, "mm"],
    ["rut_depth_mm", "Rut depth", 0, 0.3, 0.005, "mm"],
    ["rut_offset_mm", "Rut offset", 0.5, 6, 0.1, "mm"],
    ["rut_width_mm", "Rut width", 0.1, 2, 0.05, "mm"],
    ["crack_surface", "Cracked surface", 0, 1, 0.05, ""],
  ],
  detail: [
    ["scale_mm", "Scale", 0.2, 4, 0.05, "mm"],
    ["amplitude_mm", "Amplitude", 0, 0.2, 0.002, "mm"],
    ["octaves", "Octaves", 1, 4, 1, ""],
  ],
};

const LAYER_TITLES = {
  ground: "1 · Base ground", cracks: "2 · Cracked earth",
  craters: "3 · Craters", plates: "4 · Concrete plates",
  roads: "5 · Roads", detail: "6 · Detail noise",
};

const STAMP_PARAMS = [
  ["w_mm", "Width", 5, 120, 0.5, "mm", 25],
  ["h_mm", "Height", 5, 120, 0.5, "mm", 12.5],
  ["px_per_mm", "Render px/mm", 4, 40, 1, "px", 16],
];

// ---------------------------------------------------------------- state

const state = {
  config: null, seed: 42, key: null, heightRange: [-1, 1],
  mode: "hillshade",
  view: { cx: 0, cy: 0, scale: 3.0 },   // scale = screen px per mm
  stampMode: false, scaleRef: false,
  stamp: { w_mm: 25, h_mm: 12.5, rotation: 0, px_per_mm: 16, x: null, y: null },
  libSelected: null,
  pending: 0,
};

const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const tileCache = new Map();   // url -> {img, ok}
const TILE = 256;

const $ = (id) => document.getElementById(id);

function getPath(obj, path) {
  return path.split(".").reduce((o, k) => o[k], obj);
}
function setPath(obj, path, v) {
  const keys = path.split(".");
  const last = keys.pop();
  keys.reduce((o, k) => o[k], obj)[last] = v;
}

// ---------------------------------------------------------------- config

let pushTimer = null;
function schedulePush() {
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushConfig, 280);
}

async function pushConfig() {
  const res = await fetch("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ config: state.config, seed: state.seed }),
  });
  const data = await res.json();
  state.key = data.key;
  state.heightRange = data.height_range;
  draw();
  if (state.stamp.x !== null) fetchStamp();
  window.dispatchEvent(new CustomEvent("configpushed"));
}

// ---------------------------------------------------------------- tiles

function tileURL(z, tx, ty) {
  return `/api/tile/${state.key}/${state.mode}/${z}/${tx}/${ty}.png`;
}

function getTile(z, tx, ty) {
  const url = tileURL(z, tx, ty);
  let t = tileCache.get(url);
  if (!t) {
    t = { img: new Image(), ok: false };
    t.img.onload = () => { t.ok = true; state.pending--; updateBusy(); draw(); };
    t.img.onerror = () => { state.pending--; updateBusy(); };
    state.pending++; updateBusy();
    t.img.src = url;
    tileCache.set(url, t);
    if (tileCache.size > 900) {          // crude eviction: drop oldest third
      const keys = [...tileCache.keys()].slice(0, 300);
      for (const k of keys) tileCache.delete(k);
    }
  }
  return t;
}

function updateBusy() {
  $("busy").hidden = state.pending <= 0;
}

// ---------------------------------------------------------------- drawing

function zoomLevel() {
  // tile ppm = 2^z/16; pick z so tiles are rendered at >= ~84% screen res
  const z = Math.ceil(Math.log2(state.view.scale * 16) - 0.25);
  return Math.max(0, Math.min(12, z));
}

function worldToScreen(x, y) {
  return [
    canvas.width / 2 + (x - state.view.cx) * state.view.scale,
    canvas.height / 2 + (y - state.view.cy) * state.view.scale,
  ];
}
function screenToWorld(sx, sy) {
  return [
    state.view.cx + (sx - canvas.width / 2) / state.view.scale,
    state.view.cy + (sy - canvas.height / 2) / state.view.scale,
  ];
}

function draw() {
  if (!state.key) return;
  const { width: W, height: H } = canvas;
  ctx.fillStyle = "#141518";
  ctx.fillRect(0, 0, W, H);

  const z = zoomLevel();
  const tppm = Math.pow(2, z) / 16;      // tile px per mm
  const tileMM = TILE / tppm;
  const [wx0, wy0] = screenToWorld(0, 0);
  const [wx1, wy1] = screenToWorld(W, H);
  const tx0 = Math.floor(wx0 / tileMM), tx1 = Math.floor(wx1 / tileMM);
  const ty0 = Math.floor(wy0 / tileMM), ty1 = Math.floor(wy1 / tileMM);

  ctx.imageSmoothingEnabled = state.view.scale < tppm;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const t = getTile(z, tx, ty);
      const [sx, sy] = worldToScreen(tx * tileMM, ty * tileMM);
      const s = tileMM * state.view.scale;
      if (t.ok) {
        ctx.drawImage(t.img, sx, sy, s + 0.5, s + 0.5);
      } else {
        // fallback: scaled-up parent tile while loading
        const pz = z - 1;
        if (pz >= 0) {
          const ptileMM = TILE / (Math.pow(2, pz) / 16);
          const ptx = Math.floor(tx * tileMM / ptileMM);
          const pty = Math.floor(ty * tileMM / ptileMM);
          const pt = tileCache.get(tileURL(pz, ptx, pty));
          if (pt && pt.ok) {
            const offx = (tx * tileMM - ptx * ptileMM) / ptileMM * TILE;
            const offy = (ty * tileMM - pty * ptileMM) / ptileMM * TILE;
            const frac = tileMM / ptileMM * TILE;
            ctx.drawImage(pt.img, offx, offy, frac, frac, sx, sy, s + 0.5, s + 0.5);
          }
        }
      }
    }
  }

  drawStampMarker();
  if (state.scaleRef) drawScaleRef();
}

function drawStampMarker() {
  if (state.stamp.x === null) return;
  const { x, y, w_mm, h_mm, rotation } = state.stamp;
  const [sx, sy] = worldToScreen(x, y);
  ctx.save();
  ctx.translate(sx, sy);
  ctx.rotate(rotation * Math.PI / 180);
  const w = w_mm * state.view.scale, h = h_mm * state.view.scale;
  ctx.strokeStyle = "#ffb347";
  ctx.lineWidth = 2;
  ctx.strokeRect(-w / 2, -h / 2, w, h);
  ctx.restore();
}

function drawScaleRef() {
  const s = state.view.scale;
  const cx = canvas.width / 2, cy = canvas.height / 2;
  ctx.save();
  ctx.strokeStyle = "#5ee0a0";
  ctx.fillStyle = "#5ee0a0";
  ctx.lineWidth = 1.5;
  // 25 x 12.5 mm infantry base outline, centered
  ctx.strokeRect(cx - 12.5 * s, cy - 6.25 * s, 25 * s, 12.5 * s);
  ctx.font = "11px system-ui";
  ctx.fillText("25 × 12.5 mm base", cx - 12.5 * s, cy - 6.25 * s - 6);
  // 2 mm figure silhouette (side profile) standing next to the base
  const fx = cx + 12.5 * s + 10, fy = cy + 6.25 * s;  // feet at base bottom
  const u = 2 * s / 8;                                 // figure is 8u tall
  ctx.beginPath();
  ctx.ellipse(fx, fy - 7 * u, u, u, 0, 0, Math.PI * 2);           // head
  ctx.moveTo(fx, fy - 6 * u); ctx.lineTo(fx, fy - 2.5 * u);       // body
  ctx.moveTo(fx - u, fy - 5 * u); ctx.lineTo(fx + u, fy - 4.6 * u); // arms
  ctx.moveTo(fx, fy - 2.5 * u); ctx.lineTo(fx - u, fy);           // legs
  ctx.moveTo(fx, fy - 2.5 * u); ctx.lineTo(fx + u, fy);
  ctx.lineWidth = Math.max(1, u * 0.9);
  ctx.stroke();
  ctx.fillText("2 mm figure", fx + 8, fy - 3 * u);
  ctx.restore();
}

// ---------------------------------------------------------------- input

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, moved: false };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
  $("pos").textContent = `${wx.toFixed(1)}, ${wy.toFixed(1)} mm`;
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  state.view.cx -= dx / state.view.scale;
  state.view.cy -= dy / state.view.scale;
  drag.x = e.clientX; drag.y = e.clientY;
  draw();
});
canvas.addEventListener("pointerup", (e) => {
  canvas.classList.remove("dragging");
  const wasClick = drag && !drag.moved;
  drag = null;
  if (wasClick && state.stampMode) {
    const rect = canvas.getBoundingClientRect();
    const [wx, wy] = screenToWorld(e.clientX - rect.left, e.clientY - rect.top);
    state.stamp.x = wx; state.stamp.y = wy;
    selectTab("stamp");
    fetchStamp();
    draw();
  }
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = e.clientX - rect.left, sy = e.clientY - rect.top;
  const [wx, wy] = screenToWorld(sx, sy);
  const f = Math.pow(1.0015, -e.deltaY);
  state.view.scale = Math.max(0.05, Math.min(280, state.view.scale * f));
  // keep the point under the cursor fixed
  state.view.cx = wx - (sx - canvas.width / 2) / state.view.scale;
  state.view.cy = wy - (sy - canvas.height / 2) / state.view.scale;
  $("zoom").textContent = `${state.view.scale.toFixed(2)} px/mm`;
  draw();
}, { passive: false });

function resize() {
  canvas.width = canvas.clientWidth;
  canvas.height = canvas.clientHeight;
  draw();
}
window.addEventListener("resize", resize);

// ---------------------------------------------------------------- controls

function sliderRow(label, value, min, max, step, unit, oninput) {
  const row = document.createElement("div");
  row.className = "row";
  const lab = document.createElement("label");
  lab.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = min; input.max = max; input.step = step; input.value = value;
  const val = document.createElement("span");
  val.className = "val";
  const fmt = (v) => `${(+v) % 1 === 0 ? (+v) : (+v).toFixed(step < 0.01 ? 3 : 2)}${unit ? " " + unit : ""}`;
  val.textContent = fmt(value);
  input.addEventListener("input", () => {
    val.textContent = fmt(input.value);
    oninput(parseFloat(input.value));
  });
  row.append(lab, input, val);
  row._sync = (v) => { input.value = v; val.textContent = fmt(v); };
  return row;
}

const controlRows = [];  // {path, row} for preset-load resync

function buildControls() {
  const g = $("global-sliders");
  g.innerHTML = "";
  for (const [path, label, min, max, step, unit] of GLOBAL_PARAMS) {
    const row = sliderRow(label, getPath(state.config, path), min, max, step,
      unit, (v) => { setPath(state.config, path, v); schedulePush(); });
    controlRows.push({ path, row });
    g.appendChild(row);
  }

  const wrap = $("layer-sections");
  wrap.innerHTML = "";
  for (const [name, params] of Object.entries(LAYER_PARAMS)) {
    const sec = document.createElement("div");
    sec.className = "layer" + (name === "ground" ? " open" : "");
    const head = document.createElement("header");
    const chk = document.createElement("input");
    chk.type = "checkbox";
    chk.checked = state.config.layers[name].enabled;
    chk.addEventListener("click", (e) => e.stopPropagation());
    chk.addEventListener("change", () => {
      state.config.layers[name].enabled = chk.checked;
      sec.classList.toggle("disabled", !chk.checked);
      schedulePush();
    });
    const h4 = document.createElement("h4");
    h4.textContent = LAYER_TITLES[name];
    const chev = document.createElement("span");
    chev.className = "chev";
    chev.textContent = "▼";
    head.append(chk, h4, chev);
    head.addEventListener("click", () => sec.classList.toggle("open"));
    const body = document.createElement("div");
    body.className = "body";

    const srcNote = document.createElement("div");
    srcNote.className = "src-note";
    srcNote.dataset.layer = name;
    body.appendChild(srcNote);

    for (const [key, label, min, max, step, unit] of params) {
      const path = `layers.${name}.${key}`;
      const row = sliderRow(label, getPath(state.config, path), min, max,
        step, unit, (v) => { setPath(state.config, path, v); schedulePush(); });
      controlRows.push({ path, row });
      body.appendChild(row);
    }

    if (name === "cracks") {
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<label>Blend</label>`;
      const sel = document.createElement("select");
      for (const m of ["add", "min"]) {
        const o = document.createElement("option");
        o.value = o.textContent = m;
        sel.appendChild(o);
      }
      sel.value = state.config.layers.cracks.blend;
      sel.addEventListener("change", () => {
        state.config.layers.cracks.blend = sel.value;
        schedulePush();
      });
      row.appendChild(sel);
      body.appendChild(row);

      const inv = document.createElement("div");
      inv.className = "row";
      const invChk = document.createElement("input");
      invChk.type = "checkbox";
      invChk.checked = state.config.layers.cracks.source_invert;
      invChk.addEventListener("change", () => {
        state.config.layers.cracks.source_invert = invChk.checked;
        schedulePush();
      });
      const invLab = document.createElement("label");
      invLab.textContent = "Invert source map";
      inv.append(invChk, invLab);
      body.appendChild(inv);
    }

    sec.append(head, body);
    sec.classList.toggle("disabled", !chk.checked);
    wrap.appendChild(sec);
  }
  updateSourceNotes();
}

function updateSourceNotes() {
  for (const el of document.querySelectorAll(".src-note")) {
    const name = el.dataset.layer;
    let src = state.config.layers[name] && state.config.layers[name].source;
    if (Array.isArray(src)) src = src.length ? `pool of ${src.length}: ${src.join(", ")}` : null;
    el.textContent = src ? `source: ${src}` :
      (name === "cracks" || name === "craters" ? "procedural (no source map)" : "");
    el.style.display = (name === "cracks" || name === "craters") ? "" : "none";
  }
}

function syncControls() {
  for (const { path, row } of controlRows) row._sync(getPath(state.config, path));
  $("seed").value = state.seed;
  updateSourceNotes();
  // layer enabled checkboxes
  document.querySelectorAll("#layer-sections .layer").forEach((sec, i) => {
    const name = Object.keys(LAYER_PARAMS)[i];
    const chk = sec.querySelector("header input");
    chk.checked = state.config.layers[name].enabled;
    sec.classList.toggle("disabled", !chk.checked);
  });
}

// ---------------------------------------------------------------- stamp

function buildStampControls() {
  const wrap = $("stamp-controls");
  for (const [key, label, min, max, step, unit, dflt] of STAMP_PARAMS) {
    state.stamp[key] = dflt;
    wrap.appendChild(sliderRow(label, dflt, min, max, step, unit, (v) => {
      state.stamp[key] = v;
      if (state.stamp.x !== null) { scheduleStamp(); draw(); }
    }));
  }
  $("stamp-rot").addEventListener("input", () => {
    state.stamp.rotation = parseFloat($("stamp-rot").value);
    $("stamp-rot-val").textContent = `${state.stamp.rotation}°`;
    if (state.stamp.x !== null) { scheduleStamp(); draw(); }
  });
}

let stampTimer = null;
function scheduleStamp() {
  clearTimeout(stampTimer);
  stampTimer = setTimeout(fetchStamp, 220);
}

async function fetchStamp() {
  const s = state.stamp;
  if (s.x === null || !state.key) return;
  const res = await fetch("/api/stamp", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      key: state.key, x: s.x, y: s.y, w_mm: s.w_mm, h_mm: s.h_mm,
      rotation: s.rotation, px_per_mm: s.px_per_mm, mode: state.mode,
    }),
  });
  if (!res.ok) return;
  const data = await res.json();
  $("stamp-result").hidden = false;
  $("stamp-img").src = `data:image/png;base64,${data.png}`;
  $("stamp-download").href = `data:image/png;base64,${data.heightmap_png}`;
  const st = data.stats;
  $("stamp-stats").innerHTML =
    `<span>min <b>${st.min.toFixed(3)} mm</b></span>` +
    `<span>max <b>${st.max.toFixed(3)} mm</b></span>` +
    `<span>mean <b>${st.mean.toFixed(3)} mm</b></span>` +
    `<span>relief <b>${st.relief.toFixed(3)} mm</b></span>`;
  drawHistogram(data.histogram);
}

function drawHistogram(hist) {
  const c = $("stamp-hist");
  const g = c.getContext("2d");
  g.fillStyle = "#1b1d21";
  g.fillRect(0, 0, c.width, c.height);
  const n = hist.counts.length;
  const maxC = Math.max(...hist.counts, 1);
  const w = (c.width - 20) / n;
  g.fillStyle = "#3d6fa8";
  for (let i = 0; i < n; i++) {
    const h = (c.height - 26) * hist.counts[i] / maxC;
    g.fillRect(10 + i * w, c.height - 16 - h, Math.max(1, w - 1), h);
  }
  g.fillStyle = "#8a909c";
  g.font = "10px system-ui";
  g.fillText(`${hist.edges[0].toFixed(2)} mm`, 10, c.height - 4);
  const right = `${hist.edges[n].toFixed(2)} mm`;
  g.fillText(right, c.width - 10 - g.measureText(right).width, c.height - 4);
}

// ---------------------------------------------------------------- presets

async function refreshPresets() {
  const data = await (await fetch("/api/presets")).json();
  const sel = $("preset-list");
  sel.innerHTML = "";
  for (const name of data.presets) {
    const o = document.createElement("option");
    o.value = o.textContent = name;
    sel.appendChild(o);
  }
}

async function loadPreset(name) {
  const res = await fetch(`/api/presets/${encodeURIComponent(name)}`);
  if (!res.ok) return;
  const data = await res.json();
  state.config = data.config;
  state.seed = data.seed;
  state.key = data.key;
  syncControls();
  await pushConfig();
}

// ---------------------------------------------------------------- library

async function refreshLibrary() {
  const data = await (await fetch("/api/library")).json();
  const grid = $("lib-grid");
  grid.innerHTML = "";
  if (!data.entries.length) {
    grid.innerHTML = `<p class="hint">Library is empty. Run
      <code>scripts/source_maps.py</code> or drop entries into
      <code>library/</code>.</p>`;
    return;
  }
  for (const e of data.entries) {
    const item = document.createElement("div");
    item.className = "lib-item";
    item.innerHTML = `<img loading="lazy" src="/api/library/${e.id}/thumb.png">` +
      `<div class="cap">${e.id}</div>`;
    item.addEventListener("click", () => selectLibEntry(e, item));
    grid.appendChild(item);
  }
}

function selectLibEntry(e, item) {
  document.querySelectorAll(".lib-item").forEach(i => i.classList.remove("selected"));
  item.classList.add("selected");
  state.libSelected = e.id;
  $("lib-detail").hidden = false;
  $("lib-preview").src = `/api/library/${e.id}/preview.png`;
  const m = e.metadata;
  $("lib-meta").innerHTML =
    `<b>${e.id}</b><br>` +
    `tags: ${(m.tags || []).join(", ") || "—"}<br>` +
    `source: <a href="${m.source_url || "#"}" target="_blank">${m.source_url || "?"}</a><br>` +
    `license: ${m.license || "?"} · author: ${m.author || "?"}<br>` +
    (m.physical_scale_mm ? `physical scale: ${m.physical_scale_mm} mm<br>` : "") +
    `normalization: ${(m.normalization || []).join("; ") || "—"}`;
}

function assignSource(layer, id) {
  if (layer === "craters") {
    // craters take a POOL of stamps: clicking toggles membership
    let cur = state.config.layers.craters.source || [];
    if (typeof cur === "string") cur = [cur];
    if (id === null) cur = [];
    else if (cur.includes(id)) cur = cur.filter((x) => x !== id);
    else cur = cur.concat([id]);
    state.config.layers.craters.source = cur.length ? cur : null;
  } else {
    state.config.layers[layer].source = id;
  }
  updateSourceNotes();
  schedulePush();
}

// ---------------------------------------------------------------- tabs

function selectTab(name) {
  document.querySelectorAll("#tabs button").forEach(b =>
    b.classList.toggle("active", b.dataset.tab === name));
  document.querySelectorAll(".tab").forEach(t =>
    t.classList.toggle("active", t.id === `tab-${name}`));
  window.dispatchEvent(new CustomEvent("tabchange", { detail: name }));
}

// ---------------------------------------------------------------- init

function bindUI() {
  document.querySelectorAll("#tabs button").forEach(b =>
    b.addEventListener("click", () => selectTab(b.dataset.tab)));

  document.querySelectorAll("#mode-buttons button").forEach(b =>
    b.addEventListener("click", () => {
      state.mode = b.dataset.mode;
      document.querySelectorAll("#mode-buttons button").forEach(x =>
        x.classList.toggle("active", x === b));
      draw();
      if (state.stamp.x !== null) fetchStamp();
    }));

  $("btn-stamp").addEventListener("click", () => {
    state.stampMode = !state.stampMode;
    $("btn-stamp").classList.toggle("active", state.stampMode);
    canvas.classList.toggle("stamping", state.stampMode);
  });
  $("btn-scaleref").addEventListener("click", () => {
    state.scaleRef = !state.scaleRef;
    $("btn-scaleref").classList.toggle("active", state.scaleRef);
    draw();
  });

  $("seed").addEventListener("change", () => {
    state.seed = parseInt($("seed").value) || 0;
    schedulePush();
  });
  $("btn-reroll").addEventListener("click", () => {
    state.seed = Math.floor(Math.random() * 1e9);
    $("seed").value = state.seed;
    schedulePush();
  });

  $("btn-load").addEventListener("click", () => {
    const name = $("preset-list").value;
    if (name) loadPreset(name);
  });
  $("btn-save").addEventListener("click", async () => {
    const name = $("preset-name").value.trim();
    if (!name) return;
    await fetch("/api/presets", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, config: state.config, seed: state.seed }),
    });
    refreshPresets();
  });

  $("lib-assign-cracks").addEventListener("click", () =>
    state.libSelected && assignSource("cracks", state.libSelected));
  $("lib-assign-craters").addEventListener("click", () =>
    state.libSelected && assignSource("craters", state.libSelected));
  $("lib-clear-cracks").addEventListener("click", () => assignSource("cracks", null));
  $("lib-clear-craters").addEventListener("click", () => assignSource("craters", null));
}

async function init() {
  const data = await (await fetch("/api/defaults")).json();
  state.config = data.config;
  state.seed = data.seed;
  state.key = data.key;
  $("seed").value = state.seed;
  buildControls();
  buildStampControls();
  bindUI();
  refreshPresets();
  refreshLibrary();
  resize();
  $("zoom").textContent = `${state.view.scale.toFixed(2)} px/mm`;
}

init();
