> [!NOTE]
> **🤖 All coded with LLMs.** Every line of this project — generator, server,
> viewer, STL pipeline — was written by large language models, driven through
> conversational iteration.

# Battlefield Heightmap Studio

**Procedural battlefield terrain for tabletop bases — from seeded noise to
print-ready STL.**

One large, continuous, **seeded and deterministic** terrain domain; an
interactive web viewer for tuning it; a CC0/public-domain bump-map library
for sourced texture data; and a 3D base pipeline that exports watertight,
print-oriented STLs for resin printing. Built for Legions Imperialis
(8&nbsp;mm) resin-printed bases, useful anywhere you want tiny, crisp,
reproducible terrain.

![Interactive viewer — hillshaded procedural battlefield](screenshots/readme_viewer.jpg)

All spatial parameters are **millimeters**; heights are mm of physical
relief (defaults target ~0.3–0.8 mm on a 25 mm base next to 2 mm infantry).

---

## Highlights

- **Deterministic & seamless** — same seed + config + coordinates → bit-identical
  arrays, across processes and sessions. Every layer is a pure function of
  world coordinates and hashed integer lattices; there is no RNG state.
  Adjacent tiles are bit-exact sub-windows of any larger render.
- **Unbounded domain** — nothing is precomputed; render any region at any
  resolution on demand.
- **Real lunar craters** — impacts stamp actual NASA LOLA DEMs (Tycho,
  Copernicus, Theophilus, King, Aristarchus, Bürg) extracted from LDEM_64
  via HTTP range requests.
- **Sourced textures with provenance** — every library entry records source
  URL, license, author and the exact normalization applied. CC0 / public
  domain only, by policy.
- **Print-ready output** — one binary STL: mm units, Z-up, watertight
  shells, pin sockets, snap-off supports, and a stack-for-print rack mode
  that drops straight onto the build plate.
- **High-res export decoupled from the viewer** — orbit a light preview
  mesh, download at up to 50 px/mm (20 µm/px) regardless.

---

## Setup & run

```bash
python3 -m venv .venv
.venv/bin/pip install numpy scipy pillow fastapi "uvicorn[standard]" pytest
.venv/bin/uvicorn server.app:app --host 0.0.0.0 --port 8000
# open http://<host>:8000/
```

To keep it running across reboots, `deploy/heightmap-studio.service` is
a systemd unit for this setup (adjust the paths, then
`cp deploy/*.service deploy/*.timer /etc/systemd/system/ &&
systemctl daemon-reload && systemctl enable --now heightmap-studio`).

CLI test render (no server needed):

```bash
.venv/bin/python -m battlefield.cli --seed 42 --w 256 --h 256 --ppm 3 -o test.png
.venv/bin/python -m battlefield.cli --preset presets/sourced_battlefield.json -o test.png
```

Tests:

```bash
.venv/bin/python -m pytest tests/
```

Populate the bump-map library (downloads CC0 / public-domain sources,
writes provenance metadata):

```bash
.venv/bin/python scripts/source_maps.py       # texture tiles + LOLA DEM patches
.venv/bin/python scripts/source_lunar_craters.py   # crater stamp pool (LDEM_64)
```

---

## The web viewer

Infinite pan/zoom over slippy tiles (256 px, zoom 0–12; at zoom *z* a tile
covers 4096/2^z mm). Tiles are cached on (config hash, mode, z, x, y);
hillshade is computed with a 2 px apron so lighting seams never show.

| | |
|---|---|
| **Shading modes** | Hillshade / Grey / Height (false-color) |
| **Live tuning** | sliders for every layer parameter + seed, master amplitude; visible tiles re-render live (debounced ~300 ms) |
| **Stamp preview** | click the map → enlarged crop of a base-sized rectangle with height histogram, min/max/mean/relief stats, 16-bit heightmap download |
| **Scale ref** | overlay of a 25 × 12.5 mm base outline + 2 mm figure |
| **Presets** | save/load JSON on disk (`presets/`) |

False-color height mode, craters + cracked earth on the default preset:

![False-color height mode](screenshots/readme_falsecolor.jpg)

---

## 3D bases → print

The **Bases** tab renders example bases — circular, mildly tapered frustums —
cropped from the current domain at seeded positions/rotations, in an
orbitable three.js view (vendored locally, no CDN). Layer sliders and
presets apply live. Backed by `POST /api/bases`, which returns the raw crop
grids the STL pipeline consumes.

![3D base viewer — six bases cropped live from the domain](screenshots/readme_bases3d.jpg)

Base geometry (defaults tuned for Legions Imperialis):

- **Sizes** — Ø25 mm small / Ø40 mm large, 2.2 mm slab.
- **Fixed-angle taper** — the side wall leans a set angle from vertical
  (default 3.9°: a 25 mm base tops out at 24.7 mm), so every size shares
  one wall angle.
- **Edge lip** — the bump map fades to zero over the last N mm before the
  rim; the outer edge stays a crisp flat circle regardless of terrain.
- **Recessed bottom (foot ring)** — the underside is recessed 0.2 mm
  inside a flat 1.5 mm outer foot ring (45° walls, supportless on edge),
  so the base stands on its rim: it sits level on small bumps and a
  slightly bowed print can't rock. The base's ID code stands raised on the
  recess floor, where it never rubs on the table. With pins on, the recess is
  capped so the socket floors keep ≥ 0.6 mm of material under them (a hint
  appears when that kicks in); without pins it can go to 1 mm.
- **Pin sockets (subtracted)** — N flat-floored holes on an equidistant
  polar ring (default 5 × Ø6.1 × 1.4 mm deep), with a seeded position-noise
  dial (0 = perfect ring, 1 = up to 1 mm XY error per pin).
- **Print support** — optional thin snap-off tab (0.4 mm) flush with the
  base's bottom face: a crescent hugging a full 180° of the rim, sweeping
  to a straight line on the build plate with a thicker raft foot (up to
  2 mm tall × base width, centered on the disc's mid-thickness, always
  ≥ 0.2 mm clear of the disc). Default support height is 2 mm (rim to
  plate), the height the support sweep was printed and validated at. With supports on, the STL exports in print
  orientation — discs on edge, rafts at z=0.
  - **Perforated breakaway** (default) — instead of one continuous weld
    along the rim (~16 mm² of resin to break on a Ø25 base), the tab stops
    a 0.4 mm gap short of the rim and touches it only through a row of
    teeth that neck down at 45° to 0.5 mm contacts every 2.5 mm, so it
    snaps off like a stamp perforation (~2.6 mm² total on a Ø25). A tooth
    always sits at the rim's lowest point in print orientation, so the
    disc's first layer is never an unsupported island, and the sheet ends
    1 mm past the outermost tooth rather than running on up the disc's
    sides. Contact pitch, width and gap are tunable; turn it off for the
    solid weld. (A support sweep print picked these defaults: 0.5 mm teeth
    every 2.5 mm removed easily with no line artefacts.)
  - **Teeth under the base** (option) — the same blade and teeth, with
    the whole support stepped back by the tab's thickness so the blade sits
    just behind the bottom face, and the teeth run on 0.4 mm in under the
    base, bonding to the underside's outer foot ring (0.1 mm into it)
    instead of the rim edge. The stubs end up on the bottom face, so
    sanding it flat removes them completely and the rim's visible edge is
    never touched. Same tooth angles and contact area as rim teeth, so
    sweep results carry over.
  - **Support sweep** — one plate of 19 identical bases whose supports run
    from sure things to likely failures, to find the best contact size in
    a single print: a solid-weld control, then contact widths 1.0 → 0.15 mm
    with rim teeth every 2.5 mm (row A), every 4 mm (row B), and with teeth
    under the base every 2.5 mm (row C).
    Each base gets its own export record and code, and a legend (`.txt`)
    mapping codes to variants downloads with the 3MF. Resin print time depends on height, not part
    count, so the extra bases only cost resin; terrain resolution is capped
    at 16 px/mm for the sweep since it doesn't affect support behaviour.

  ![Pin sockets and crescent print support](screenshots/m10_pins_support.png)
  ![Support tab detail — weld line hugging the rim](screenshots/m11_support_hero.png)
- **Stack for print** — racks the print-orientation units along their thin
  axis like plates in a rack: upright, center-aligned, **every raft flat on
  the plate**, controllable clearance. Import the STL and print — no
  splitting, aligning or rotating in the slicer.

![Stack for print — racked units, every raft on the build plate](screenshots/readme_stack.jpg)

- **Base configs** — save/load the whole setup (base options, pins,
  support, placement seed) with the terrain preset embedded
  (`presets/bases/*.json`).
- **Export STL** — all displayed bases (+ supports) as one binary STL: mm
  units, Z-up, watertight shells, relief at true 1× regardless of the view
  exaggeration.

### Traceability: a code on every base + versioned export records

Every export mints a short **base code** and stores a versioned record
server-side (schema version, **generator git commit**, timestamp,
complete base options, seeds and terrain config). The code is printed
**raised on the bottom of every base**: six characters, e.g. `K7Q2MR`,
in one row across the recess floor (about 3.7 mm tall on a Ø25 base, up to
6 mm on larger ones), standing 0.08 mm proud (*Code relief*, about 4
printer pixels) with the letter faces kept at least 0.05 mm short of the
foot ring, so they never touch the table. Raised letters only add
material, so they can't thin the floor under pin sockets. They need a
recess of at least the relief + 0.05 mm (0.13 mm by default; a hint says
when there isn't room), and a dry-brush or wash makes them pop.

- **The code**: 5 random characters + 1 check character from Crockford's
  base32 alphabet (digits and capitals without I, L, O, U): ~33.5 M
  codes. Reading is forgiving — lowercase is fine, O reads as 0, I and L
  as 1, spaces and hyphens are ignored — and the check character catches
  any single misread character, so a misread never opens the wrong record.
- **Look it up** with the **Find a base** box in the Bases tab, or at
  `/b/<code>`: a page showing the complete setup that produced that
  physical base, with an **"Open in the studio"** button that restores the
  whole thing live (`/?restore=<code>`). If the generator has changed
  since the export, the page and the restore flow warn that the same seed
  may no longer produce identical terrain.
- **Other marks**: *Bottom mark* can switch to a **QR code** debossed into
  the recess floor (45°-chamfered 0.25 mm modules, supportless in any
  orientation; a contrasting wash makes it scan) or to none. Records made
  before codes (schema 1) keep their 12-hex guids, which still work
  everywhere, and restore with the QR they were printed with.

The record travels four ways: the code (and `/b/` link), the STL's
80-byte header (compact summary), a `.params.json` sidecar downloaded
next to the STL, and `exports.jsonl` on the server. The letters are
DejaVu Sans Mono Bold outlines baked into a small table by
`scripts/bake_glyphs.py` and meshed into the bottom face, so each base
stays one closed shell; the QR encoder is vendored too (no CDN), byte-mode
v1–3 ECC-M, verified matrix-for-matrix against the reference python
implementation.

Records are what keep printed codes alive, so `scripts/backup_records.sh`
mirrors them (plus saved presets) into a private git repo, committing only
when something changed and never deleting; `deploy/` has a systemd timer
that runs it every 15 minutes. Records are client-supplied: the server
owns the guid / schema / commit / timestamp fields, caps record size, and
the `/b/` page escapes everything under a script-blocking CSP.

### Export formats

- **STL** — binary, universal; ~50 bytes/triangle.
- **3MF** — zip-compressed, indexed mesh: **~4–5× smaller than STL** for
  the same geometry (measured: a 100 MB STL → 21.5 MB 3MF), with the full
  export record embedded as `<metadata>`. Written by a dependency-free
  streaming writer (native `CompressionStream`), so even multi-million
  triangle exports don't hold giant buffers; entries past 4 GiB switch to
  ZIP64 automatically (normal-size files stay plain zip).

Both are assembled in the browser, so very large exports are bounded by
tab memory: the size readout under **Download res** is exact (it mirrors
the mesh builder), and an export estimated to need more than ~3 GB asks
before running. STL needs roughly 3× the memory of 3MF.

### Sending a build to the printer

`scripts/send_build.py` hands an exported 3MF to a DragonFruit
build-processor service (`BP_URL`, default `http://192.168.1.60:8010`):
it turns the build 90° on the plate (rafts along the short side; `--rotate`),
wraps the mesh as-is into a VOXL scene with **empty support lists**
(the processor's `prepare` step would re-orient it, lift it 5 mm and grow
its own supports on top of ours), slices it with the server's saved
settings, stops if the bridge check flags any layer, and uploads the
print file. It never starts a print.

```bash
.venv/bin/python scripts/send_build.py voxl build.3mf --name NAME   # -> NAME.voxl
.venv/bin/python scripts/send_build.py slice NAME.voxl              # -> job id + NAME.ctb
.venv/bin/python scripts/send_build.py send JOB_ID NAME.ctb         # upload + verify
```

### High-res export

Viewer quality and download quality are independent: the on-screen mesh
stays light for smooth orbiting, and **Export STL** re-renders every base
at the chosen **Download res** at export time. A live estimate shows
µm/px, triangle count and file size before you commit.

| Download res | XY pitch | When to use |
|---|---|---|
| 20–25 px/mm | 50–40 µm | matches typical resin LCD XY pixels — full sets |
| 40 px/mm (default) | 25 µm | maximum Z-relief fidelity — 1–2 bases per file (3MF) |
| 50 px/mm | 20 µm | overkill, but available |

---

## Generator API (what the STL pipeline uses)

```python
from battlefield import Domain, Library, load_preset

config, seed = load_preset("presets/nice looking v2.json")
dom = Domain(config, seed, library=Library("library"))

# any region on demand — the domain is unbounded, nothing is precomputed
h = dom.render_region(x=0, y=0, w_mm=512, h_mm=512, px_per_mm=4)

# a base crop: (x, y) = crop CENTER, rotation in degrees, mm heights out
crop = dom.crop(x=120.0, y=-45.0, w_mm=25.0, h_mm=12.5,
                rotation=33.7, px_per_mm=10)
```

Guarantees (all covered by `tests/test_generator.py`):

- **Deterministic** — same seed + config + coordinates → bit-identical
  arrays, across processes and sessions.
- **Seamless** — adjacent regions/tiles are bit-exact sub-windows of any
  larger render (feature spawning never depends on the query window).
- **Exact rotation** — `crop()` evaluates the field at rotated sample
  coordinates directly, no resampling. 90° crops equal `np.rot90` of the
  unrotated crop.

Config is a plain JSON dict (see `battlefield/config.py` for the full
schema + defaults); presets on disk are `{"seed": ..., "config": ...}`.

---

## Terrain layers

1. **Base ground** — fBm macro undulation + fine roughness.
2. **Cracked earth** — domain-warped Worley cell edges carved as negative
   displacement (cell size / width / depth / falloff), *or* a sourced
   cracked-earth map tiled with variation (mirror tiling + rotated second
   sample blended by low-frequency noise). Blend: add / min.
3. **Craters** — seeded spawn cells; by default each crater stamps a real
   lunar DEM from a **pool** (Tycho, Copernicus, Theophilus, King,
   Aristarchus, Bürg — NASA LOLA LDEM_64, 473 m/px, longitude stretch
   corrected). Bowl depth and rim height scale independently (real lunar
   rim/depth ratios read too weak at miniature scale). Impacts wipe the
   crack layer inside bowl+rim (`crack_clearing`). Analytic profile
   (parabolic bowl, gaussian rim, exponential ejecta) available via
   `source_mix` / `source: null`. Newer craters locally carve older ones.

   ![Real lunar crater stamp close-up](screenshots/m7_crater_closeup.png)
4. **Concrete plates** — big slabs on a rotated grid, appearing in
   noise-driven patches (whole tiles in/out): expansion joints where the
   earth shows through, per-tile lift/tilt (subsided slabs), broken tiles
   with crack networks, missing tiles, and craters shatter the paving
   inside their footprint. Fully vectorized, no feature loops.
5. **Roads** — node grid + probabilistic edges/junctions, midpoint-displaced
   and Chaikin-smoothed splines; corridor flattens terrain toward the macro
   surface with a slight negative offset, length-varying berms, wheel ruts
   and cracked-surface show-through. **Craters interrupt roads** (impacts
   blow the roadbed away inside bowl + rim, same as plates). **Off by
   default** (see `presets/roads_instead_of_plates.json`):

   ![Roads — worn tracks across cracked earth, interrupted by impacts](screenshots/readme_roads.jpg)
6. **Detail noise** — final high-frequency layer (suppressed on roads and
   damped on plates).

---

## Bump-map library

`library/<entry>/height.png` (16-bit, normalized 0..1) + `metadata.json`
(source URL, file URL, license, author, tags, original resolution, physical
scale where reported, and the exact normalization steps applied). Import
normalization: greyscale → optional downscale → slope strip (gaussian
high-pass for texture tiles, best-fit plane for DEM patches) → percentile
remap to full range.

The **Library** tab shows hillshaded thumbnails of every entry with full
provenance; assign any entry to the cracks layer or as crater stamps.

![Library tab — sourced heightmaps with provenance](screenshots/readme_library.jpg)

Starter set — 17 entries:

| entries | source | license |
|---|---|---|
| cracked mud ×3, tire-rut mud, rocky ground ×2, cracked asphalt | Poly Haven | CC0 1.0 |
| fine gravel, damaged asphalt, dry eroded dirt | ambientCG | CC0 1.0 |
| crater stamp pool ×6 — Tycho, Copernicus, Theophilus, King, Aristarchus, Bürg — plus a farside highlands field (all LOLA LDEM_64 extracts) | NASA LRO LOLA / PDS | public domain |

Not every entry is wired into a preset — the library is a palette: any
entry can be assigned to the cracks layer or the crater stamp pool from
the Library tab.

Only CC0 / public-domain sources are in the manifest; anything with an
unclear license is skipped by policy.

---

## Performance

256 px tiles render in ~0.05–0.4 s on CPU at typical zooms (z0, the most
zoomed-out level, ~1.2 s on first hit); repeat hits are served from the LRU
cache in <1 ms. Display-only LOD (`lod=True` in `render_region`) skips
sub-pixel craters and fades sub-pixel noise octaves at far zooms; crops
never use LOD and are always exact.

---

## Milestones

| # | milestone | screenshot |
|---|---|---|
| 1 | generator + CLI render | ![m1](screenshots/m1_cli_render.png) |
| 2 | tile server + pan/zoom viewer | ![m2](screenshots/m2_viewer.png) |
| 3 | sliders wired, false-color mode | ![m3](screenshots/m3_sliders_falsecolor.png) |
| 4 | stamp preview + scale ref | ![m4](screenshots/m4_stamp.png) |
| 5 | library browser | ![m5](screenshots/m5_library.png) |
| 6 | sourced cracks + LOLA crater stamps | ![m6](screenshots/m6_sourced_cli.png) |
| 7 | real lunar crater pool (LDEM_64) + crack clearing | ![m7](screenshots/m7_real_craters_viewer.png) |
| 8 | concrete plates layer (replaces roads by default) | ![m8](screenshots/m8_plates_viewer.png) |
| 9 | 3D base viewer tab (tapered round bases) | ![m9](screenshots/m9_bases3d.png) |
| 10 | pin sockets, snap-off supports, stack-for-print, high-res STL export | ![stack](screenshots/readme_stack.jpg) |

---

## License

- **Project code** — [PolyForm Noncommercial 1.0.0](LICENSE.md): free to
  use, modify and share for any noncommercial purpose.
- **`library/`** — sourced heightmaps remain CC0 1.0 / public domain, as
  recorded per-entry in each `metadata.json`.
- **`server/static/vendor/`** — three.js and OrbitControls, MIT licensed;
  `glyphs.js` holds outlines from DejaVu Sans Mono Bold (Bitstream Vera
  licence, `DEJAVU-LICENSE.txt`).

See [LICENSE-NOTES.md](LICENSE-NOTES.md) for the breakdown.
