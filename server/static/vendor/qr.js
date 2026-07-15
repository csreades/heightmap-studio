/* Minimal QR encoder — byte mode, ECC level M, versions 1-3, standard
   mask selection by penalty score. No dependencies; correctness verified
   matrix-for-matrix against the python `qrcode` reference implementation
   (see scripts/test_qr.py). Exposes qrEncode(text) -> {size, get(x,y)}.
   Public domain quality-of-implementation; QR is ISO/IEC 18004. */
"use strict";
(function (root) {

  // ---- version tables (ECC level M, single RS block for v1-3) ----------
  const VER = [
    null,
    { size: 21, data: 16, ecc: 10, align: [] },
    { size: 25, data: 28, ecc: 16, align: [6, 18] },
    { size: 29, data: 44, ecc: 26, align: [6, 22] },
  ];

  // ---- GF(256), poly 0x11d ---------------------------------------------
  const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x; LOG[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;

  function rsGenerator(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) {
        ng[j] ^= gmul(g[j], EXP[i]);
        ng[j + 1] ^= g[j];
      }
      g = ng;
    }
    return g.reverse();   // highest degree first
  }

  function rsEncode(data, n) {
    const gen = rsGenerator(n);
    const res = new Uint8Array(data.length + n);
    res.set(data);
    for (let i = 0; i < data.length; i++) {
      const f = res[i];
      if (!f) continue;
      for (let j = 1; j < gen.length; j++) res[i + j] ^= gmul(gen[j], f);
    }
    return res.slice(data.length);
  }

  // ---- bit packing -------------------------------------------------------
  function makeCodewords(bytes, ver) {
    const cap = VER[ver].data;
    const bits = [];
    const push = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
    push(4, 4);                  // byte mode
    push(bytes.length, 8);       // count (8 bits for v1-9 byte mode)
    for (const b of bytes) push(b, 8);
    const cb = cap * 8;
    push(0, Math.min(4, cb - bits.length));       // terminator
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    const pads = [0xec, 0x11];
    for (let i = 0; data.length < cap; i++) data.push(pads[i & 1]);
    return new Uint8Array(data);
  }

  // ---- matrix ------------------------------------------------------------
  function buildMatrix(ver, codewords, mask) {
    const N = VER[ver].size;
    const m = new Int8Array(N * N).fill(-1);      // -1 = free
    const set = (x, y, v) => { m[y * N + x] = v ? 1 : 0; };
    const at = (x, y) => m[y * N + x];

    function finder(cx, cy) {
      for (let dy = -1; dy <= 7; dy++)
        for (let dx = -1; dx <= 7; dx++) {
          const x = cx + dx, y = cy + dy;
          if (x < 0 || y < 0 || x >= N || y >= N) continue;
          const inC = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6;
          const ring = inC && (dx === 0 || dx === 6 || dy === 0 || dy === 6);
          const core = dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4;
          set(x, y, inC && (ring || core) ? 1 : 0);
        }
    }
    finder(0, 0); finder(N - 7, 0); finder(0, N - 7);

    for (let i = 8; i < N - 8; i++) {             // timing
      set(i, 6, i % 2 === 0); set(6, i, i % 2 === 0);
    }
    for (const cy of VER[ver].align)              // alignment
      for (const cx of VER[ver].align) {
        if (at(cx, cy) !== -1 && (cx < 8 && cy < 8)) continue;
        if ((cx < 9 && cy < 9) || (cx > N - 10 && cy < 9) || (cx < 9 && cy > N - 10)) continue;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            set(cx + dx, cy + dy,
                Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    set(8, N - 8, 1);                             // dark module

    // reserve format areas
    const fmtCells = [];
    for (let i = 0; i <= 8; i++) {
      if (i !== 6) { fmtCells.push([8, i]); fmtCells.push([i, 8]); }
    }
    for (let i = 0; i < 8; i++) fmtCells.push([N - 1 - i, 8]);
    for (let i = 0; i < 7; i++) fmtCells.push([8, N - 1 - i]);
    for (const [x, y] of fmtCells) if (at(x, y) === -1) set(x, y, 0);

    // data placement: zigzag from bottom-right, skip column 6
    const total = new Uint8Array(VER[ver].data + VER[ver].ecc);
    total.set(codewords);
    const bits = [];
    for (const b of total) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
    let bi = 0, up = true;
    for (let col = N - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < N; k++) {
        const y = up ? N - 1 - k : k;
        for (const x of [col, col - 1]) {
          if (at(x, y) !== -1) continue;
          let v = bi < bits.length ? bits[bi++] : 0;
          if (maskAt(mask, x, y)) v ^= 1;
          set(x, y, v);
        }
      }
      up = !up;
    }

    // format info (ECC M = 00) + mask, BCH + fixed XOR
    let fmt = (0 << 3) | mask;                    // M level bits are 00
    let rem = fmt << 10;
    for (let i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= 0x537 << (i - 10);
    fmt = ((fmt << 10) | rem) ^ 0x5412;
    const fbit = (i) => (fmt >> i) & 1;
    const tl = [[0,8],[1,8],[2,8],[3,8],[4,8],[5,8],[7,8],[8,8],[8,7],[8,5],[8,4],[8,3],[8,2],[8,1],[8,0]];
    for (let i = 0; i < 15; i++) set(tl[i][0], tl[i][1], fbit(14 - i));
    const bl = [];
    for (let i = 0; i < 7; i++) bl.push([8, N - 1 - i]);
    for (let i = 0; i < 8; i++) bl.push([N - 8 + i, 8]);
    for (let i = 0; i < 15; i++) set(bl[i][0], bl[i][1], fbit(14 - i));

    return { size: N, m };
  }

  function maskAt(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (((y / 2) | 0) + ((x / 3) | 0)) % 2 === 0;
      case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
      case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
      case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    }
  }

  function penalty(size, m) {
    const at = (x, y) => m[y * size + x];
    let score = 0;
    // N1: runs of 5+
    for (let pass = 0; pass < 2; pass++) {
      for (let a = 0; a < size; a++) {
        let run = 1;
        for (let b = 1; b < size; b++) {
          const cur = pass ? at(a, b) : at(b, a);
          const prev = pass ? at(a, b - 1) : at(b - 1, a);
          if (cur === prev) {
            run++;
            if (b === size - 1 && run >= 5) score += run - 2;
          } else {
            if (run >= 5) score += run - 2;
            run = 1;
          }
        }
      }
    }
    // N2: 2x2 blocks
    for (let y = 0; y < size - 1; y++)
      for (let x = 0; x < size - 1; x++) {
        const v = at(x, y);
        if (v === at(x + 1, y) && v === at(x, y + 1) && v === at(x + 1, y + 1))
          score += 3;
      }
    // N3: finder-like 1011101 with 4 light either side
    const pat1 = [1,0,1,1,1,0,1,0,0,0,0], pat2 = [0,0,0,0,1,0,1,1,1,0,1];
    for (let pass = 0; pass < 2; pass++)
      for (let a = 0; a < size; a++)
        for (let b = 0; b <= size - 11; b++) {
          let m1 = true, m2 = true;
          for (let k = 0; k < 11; k++) {
            const v = pass ? at(a, b + k) : at(b + k, a);
            if (v !== pat1[k]) m1 = false;
            if (v !== pat2[k]) m2 = false;
          }
          if (m1) score += 40;
          if (m2) score += 40;
        }
    // N4: dark proportion
    let dark = 0;
    for (let i = 0; i < size * size; i++) dark += m[i];
    const pct = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return score;
  }

  function qrEncode(text) {
    const bytes = [];
    for (const ch of new TextEncoder().encode(text)) bytes.push(ch);
    let ver = 0;
    for (let v = 1; v <= 3; v++) {
      const capBits = VER[v].data * 8;
      if (4 + 8 + bytes.length * 8 <= capBits) { ver = v; break; }
    }
    if (!ver) throw new Error(`payload too long for QR v3-M: ${bytes.length} bytes`);
    const data = makeCodewords(bytes, ver);
    const ecc = rsEncode(data, VER[ver].ecc);
    const cw = new Uint8Array(data.length + ecc.length);
    cw.set(data); cw.set(ecc, data.length);

    let best = null, bestScore = Infinity, bestMask = 0;
    for (let mask = 0; mask < 8; mask++) {
      const { size, m } = buildMatrix(ver, cw, mask);
      const s = penalty(size, m);
      if (s < bestScore) { bestScore = s; best = m; bestMask = mask; }
    }
    const size = VER[ver].size;
    return {
      size, version: ver, mask: bestMask,
      get: (x, y) => best[y * size + x] === 1,
      matrix: best,
    };
  }

  // encode with a forced mask — used only by the test harness
  qrEncode._forced = function (text, mask) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let ver = 0;
    for (let v = 1; v <= 3; v++)
      if (4 + 8 + bytes.length * 8 <= VER[v].data * 8) { ver = v; break; }
    const data = makeCodewords(Uint8Array.from(bytes), ver);
    const ecc = rsEncode(data, VER[ver].ecc);
    const cw = new Uint8Array(data.length + ecc.length);
    cw.set(data); cw.set(ecc, data.length);
    const { size, m } = buildMatrix(ver, cw, mask);
    return { size, version: ver, mask, matrix: m };
  };

  root.qrEncode = qrEncode;
})(typeof self !== "undefined" ? self : globalThis);
