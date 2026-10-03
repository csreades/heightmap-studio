"""Send an exported build to the printer through the build-processor API.

Our exports already carry their own supports and sit in print orientation
(rafts at z=0), so the build processor's `prepare` step (auto-orient, 5 mm
lift, auto-supports) must NOT touch them. Instead the 3MF is wrapped as-is
into a DragonFruit VOXL scene with empty support lists, then sliced with the
server's saved settings and uploaded. Printing is never started.

  .venv/bin/python scripts/send_build.py voxl  build.3mf --name NAME   # -> NAME.voxl
                                       [--rotate 90]  # turn on the plate (default 90)
  .venv/bin/python scripts/send_build.py slice NAME.voxl               # -> slice job id
  .venv/bin/python scripts/send_build.py send  JOB_ID FILE.ctb         # upload, verify

  BP_URL  build processor (default http://192.168.1.60:8010)
"""
import argparse
import datetime
import json
import os
import struct
import sys
import time
import urllib.request
import zipfile
import zlib

import numpy as np

BP = os.environ.get("BP_URL", "http://192.168.1.60:8010")
PLATE_MM = (211.68, 118.37)   # Saturn 4 Ultra 16K build area (X, Y)


# ------------------------------------------------------------------ 3MF in

def read_3mf(path):
    """Vertices (N,3 float64) and triangles (M,3 int64) of every object in
    our own 3MF exports (one object; tidy <vertex>/<triangle> tags)."""
    xml = zipfile.ZipFile(path).read("3D/3dmodel.model")
    a = xml.index(b"<vertices>") + 10
    b = xml.index(b"</vertices>")
    vb = (xml[a:b].replace(b'<vertex x="', b" ").replace(b'" y="', b" ")
          .replace(b'" z="', b" ").replace(b'"/>', b" "))
    V = np.fromstring(vb.decode("ascii"), dtype=np.float64, sep=" ").reshape(-1, 3)
    del vb
    a = xml.index(b"<triangles>") + 11
    b = xml.index(b"</triangles>")
    tb = (xml[a:b].replace(b'<triangle v1="', b" ").replace(b'" v2="', b" ")
          .replace(b'" v3="', b" ").replace(b'"/>', b" "))
    del xml
    T = np.fromstring(tb.decode("ascii"), dtype=np.int64, sep=" ").reshape(-1, 3)
    return V, T


# ------------------------------------------------------------------ VOXL out

def stl_chunks(V, T, block=1_000_000):
    """Binary STL bytes, yielded in blocks (keeps memory flat)."""
    yield b"heightmap-studio".ljust(80, b"\0") + struct.pack("<I", len(T))
    rec = np.dtype([("n", "<f4", 3), ("v", "<f4", 9), ("a", "<u2")])
    for s in range(0, len(T), block):
        tri = V[T[s:s + block]].astype(np.float32)           # (k,3,3)
        n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        r = np.zeros(len(tri), dtype=rec)
        r["n"] = n
        r["v"] = tri.reshape(-1, 9)
        yield r.tobytes()


def rotate_z(V, deg):
    """Turn the build about the vertical axis. Craig's preferred plate
    orientation is 90°: the exports lay rafts along X (the plate's long
    side); turned 90° they run along the short side."""
    t = np.deg2rad(deg)
    c, s_ = np.cos(t), np.sin(t)
    R = V.copy()
    R[:, 0] = c * V[:, 0] - s_ * V[:, 1]
    R[:, 1] = s_ * V[:, 0] + c * V[:, 1]
    return R


def write_voxl(V, T, out, name):
    """DragonFruit VOXL v2: META, SCNE, MODL, MESH (zlib binary STL), SUPP.
    The mesh is centred on its bounding box and placed by the model
    transform so its lowest point (the rafts) sits exactly on the plate."""
    lo, hi = V.min(axis=0), V.max(axis=0)
    if hi[0] - lo[0] > PLATE_MM[0] or hi[1] - lo[1] > PLATE_MM[1]:
        raise SystemExit(f"build footprint {hi[0]-lo[0]:.1f} x {hi[1]-lo[1]:.1f} mm "
                         f"doesn't fit the {PLATE_MM[0]} x {PLATE_MM[1]} mm plate")
    centre = (lo + hi) / 2
    Vc = V - centre
    height = float(hi[2] - lo[2])

    comp = zlib.compressobj(6)
    parts, usize = [], 0
    for chunk in stl_chunks(Vc, T):
        usize += len(chunk)
        parts.append(comp.compress(chunk))
    parts.append(comp.flush())
    mesh = b"".join(parts)

    now = datetime.datetime.now(datetime.timezone.utc)
    iso = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    mid = "heightmap-build"
    meta = {"generator": "heightmap-studio", "createdAt": iso, "updatedAt": iso,
            "units": "mm", "coordinateSystem": "right-handed-z-up"}
    scene = {"activeModelId": mid, "selectedModelIds": [mid]}
    models = [{
        "id": mid, "name": f"{name}.stl", "visible": True, "color": "#a3a3a3",
        "polygonCount": int(len(T)),
        "transform": {"position": {"x": 0, "y": 0, "z": height / 2},
                      "rotation": {"x": 0, "y": 0, "z": 0},
                      "scale": {"x": 1, "y": 1, "z": 1}},
        "mesh": {"mode": "embedded-chunk", "fileName": f"{name}.stl",
                 "mimeType": "model/stl", "uncompressedSizeBytes": usize},
    }]
    supports = {"version": 1,
                "meta": {"source": "heightmap-studio",
                         "objectCenter": {"x": 0, "y": 0, "z": 0},
                         "updatedAt": int(now.timestamp() * 1000)}}
    for k in ("roots", "trunks", "branches", "leaves", "twigs", "sticks",
              "braces", "stumps", "knots", "kickstands"):
        supports[k] = []      # the build carries its own supports

    def js(o):
        return json.dumps(o, separators=(",", ":")).encode()

    chunks = [  # (type, index, compression, payload, uncompressed size)
        (b"META", 0, 0, js(meta), None),
        (b"SCNE", 0, 0, js(scene), None),
        (b"MODL", 0, 1, zlib.compress(js(models), 6), len(js(models))),
        (b"MESH", 0, 1, mesh, usize),
        (b"SUPP", 0, 1, zlib.compress(js(supports), 6), len(js(supports))),
    ]
    head = struct.pack("<4sHHII", b"VOXL", 2, 0, len(chunks), 0)
    off = 16 + 20 * len(chunks)
    dirs, body = [], []
    for typ, idx, cmp_, data, us in chunks:
        dirs.append(struct.pack("<4sHHIII", typ, idx, cmp_, off, len(data),
                                us if us is not None else len(data)))
        body.append(data)
        off += len(data)
    if off >= 2 ** 32:
        raise SystemExit("VOXL v2 offsets are 32-bit; build too large")
    with open(out, "wb") as f:
        f.write(head)
        f.writelines(dirs)
        f.writelines(body)
    return {"triangles": int(len(T)), "stl_bytes": usize, "voxl_bytes": off,
            "footprint_mm": [round(float(hi[0] - lo[0]), 2), round(float(hi[1] - lo[1]), 2)],
            "height_mm": round(height, 2), "min_z": float(lo[2])}


def check_voxl(path):
    """Re-read a VOXL with the same rules as DragonFruit's parseVoxlBinaryV2."""
    b = open(path, "rb").read()
    magic, ver, _flags, count, _r = struct.unpack_from("<4sHHII", b, 0)
    assert magic == b"VOXL" and ver in (2, 3), (magic, ver)
    found = {}
    for i in range(count):
        typ, idx, cmp_, off, size, us = struct.unpack_from("<4sHHIII", b, 16 + 20 * i)
        assert off + size <= len(b), f"{typ} beyond file"
        data = zlib.decompress(b[off:off + size]) if cmp_ == 1 else b[off:off + size]
        assert cmp_ in (0, 1) and len(data) == us, f"{typ} size mismatch"
        found[(typ.decode(), idx)] = data
    assert ("META", 0) in found and ("SUPP", 0) in found
    models = json.loads(found[("MODL", 0)])
    stl = found[("MESH", 0)]
    assert len(stl) == models[0]["mesh"]["uncompressedSizeBytes"]
    ntri = struct.unpack_from("<I", stl, 80)[0]
    assert len(stl) == 84 + 50 * ntri == 84 + 50 * models[0]["polygonCount"]
    supp = json.loads(found[("SUPP", 0)])
    return {"models": len(models), "triangles": ntri,
            "supports": sum(len(v) for v in supp.values() if isinstance(v, list))}


# ------------------------------------------------------------------ API

def api(method, path, body=None, raw=None, timeout=60):
    data, headers = None, {}
    if body is not None:
        data, headers = json.dumps(body).encode(), {"content-type": "application/json"}
    if raw is not None:
        data, headers = raw, {"content-length": str(os.path.getsize(raw.name))}
    req = urllib.request.Request(BP + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        txt = r.read()
    return json.loads(txt) if txt[:1] in (b"{", b"[") else txt


def wait(job_id):
    last = None
    while True:
        j = api("GET", f"/api/jobs/{job_id}")["job"]
        prog = j.get("progress") or {}
        line = f"  {j['state']} {prog.get('phase', '')} {prog.get('done', '')}/{prog.get('total', '')}"
        if line != last:
            print(line, flush=True)
            last = line
        if j["state"] in ("done", "failed", "cancelled"):
            return j
        time.sleep(1)


def run_job(kind, options, files=()):
    job = api("POST", "/api/jobs", {"kind": kind, "options": options})["job"]
    print(f"{kind} job {job['id']}")
    for path in files:
        with open(path, "rb") as f:
            api("PUT", f"/api/jobs/{job['id']}/files/{os.path.basename(path)}",
                raw=f, timeout=3600)
    api("POST", f"/api/jobs/{job['id']}/start")
    return wait(job["id"])


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("voxl"); v.add_argument("build"); v.add_argument("--name", required=True)
    v.add_argument("--rotate", type=float, default=90.0,
                   help="degrees about the vertical axis (default 90: rafts along the plate's short side)")
    s = sub.add_parser("slice"); s.add_argument("voxl"); s.add_argument("--settings", default="default")
    d = sub.add_parser("send"); d.add_argument("job"); d.add_argument("file")
    a = ap.parse_args()

    if a.cmd == "voxl":
        V, T = read_3mf(a.build)
        if a.rotate % 360:
            V = rotate_z(V, a.rotate)
        info = write_voxl(V, T, f"{a.name}.voxl", a.name)
        info["rotated_deg"] = a.rotate
        print(json.dumps(info))
        print("re-read:", json.dumps(check_voxl(f"{a.name}.voxl")))
    elif a.cmd == "slice":
        name = os.path.splitext(os.path.basename(a.voxl))[0]
        j = run_job("slice", {"outputName": name, "settings": a.settings}, [a.voxl])
        print(json.dumps({k: j.get(k) for k in ("id", "state", "outputs", "result", "error")}, indent=1))
        bridge = (j.get("result") or {}).get("bridge") or {}
        if bridge.get("flagged_layers"):
            print("STOP: bridge check flagged layers -- do not send", file=sys.stderr)
            sys.exit(2)
    elif a.cmd == "send":
        j = run_job("send", {"jobId": a.job, "fileName": a.file})   # never startPrint
        print(json.dumps({k: j.get(k) for k in ("id", "state", "result", "error")}, indent=1))


if __name__ == "__main__":
    main()
