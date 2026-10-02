/* Streaming 3MF writer — plain JS, no dependencies. Builds a ZIP with
   deflate via the native CompressionStream API, generating the model XML
   in chunks so multi-million-triangle exports don't hold giant strings.
   Used by bases.js; also runs under node >= 18 for tests. */
"use strict";
(function (root) {

  // ---- CRC32 (incremental) ----------------------------------------------
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crcUpdate(crc, bytes) {
    let c = crc ^ 0xffffffff;
    for (let i = 0; i < bytes.length; i++)
      c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  const enc = new TextEncoder();
  // ---- minimal ZIP writer -------------------------------------------------
  // Each entry is fully compressed before its header is written, so sizes
  // and CRC go straight into the local header (no data descriptors).
  // Entries or offsets past 4 GiB switch that record to ZIP64 -- a large
  // high-res model entry would otherwise wrap its 32-bit sizes and produce
  // a corrupt file. Small archives stay plain zip for maximum
  // compatibility.
  const U32 = 0xffffffff;
  const setU64 = (dv, o, v) => {
    dv.setUint32(o, v % 4294967296, true);
    dv.setUint32(o + 4, Math.floor(v / 4294967296), true);
  };

  class ZipWriter {
    constructor() { this.chunks = []; this.offset = 0; this.central = []; this.zip64 = false; }
    _push(u8) { this.chunks.push(u8); this.offset += u8.length; }

    _entry(name, method, crc, csize, usize, data) {
      const n = enc.encode(name);
      const off = this.offset;
      const big = csize >= U32 || usize >= U32;
      const bigOff = off >= U32;
      if (big || bigOff) this.zip64 = true;
      const ver = big || bigOff ? 45 : 20;

      const lx = big ? 20 : 0;        // local zip64 extra: both sizes
      const h = new Uint8Array(30 + n.length + lx);
      const hv = new DataView(h.buffer);
      hv.setUint32(0, 0x04034b50, true);
      hv.setUint16(4, ver, true);
      hv.setUint16(8, method, true);
      hv.setUint32(14, crc, true);
      hv.setUint32(18, big ? U32 : csize, true);
      hv.setUint32(22, big ? U32 : usize, true);
      hv.setUint16(26, n.length, true);
      hv.setUint16(28, lx, true);
      h.set(n, 30);
      if (big) {
        hv.setUint16(30 + n.length, 0x0001, true);
        hv.setUint16(32 + n.length, 16, true);
        setU64(hv, 34 + n.length, usize);
        setU64(hv, 42 + n.length, csize);
      }
      this._push(h);
      for (const c of data) this._push(c);

      // central record: zip64 extra carries only the fields set to 0xffffffff
      const cx = (big ? 16 : 0) + (bigOff ? 8 : 0);
      const c = new Uint8Array(46 + n.length + (cx ? 4 + cx : 0));
      const cv = new DataView(c.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, ver, true);
      cv.setUint16(6, ver, true);
      cv.setUint16(10, method, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, big ? U32 : csize, true);
      cv.setUint32(24, big ? U32 : usize, true);
      cv.setUint16(28, n.length, true);
      cv.setUint16(30, cx ? 4 + cx : 0, true);
      cv.setUint32(42, bigOff ? U32 : off, true);
      c.set(n, 46);
      if (cx) {
        let o = 46 + n.length;
        cv.setUint16(o, 0x0001, true); cv.setUint16(o + 2, cx, true); o += 4;
        if (big) { setU64(cv, o, usize); setU64(cv, o + 8, csize); o += 16; }
        if (bigOff) setU64(cv, o, off);
      }
      this.central.push(c);
    }

    addStored(name, text) {
      const data = enc.encode(text);
      this._entry(name, 0, crcUpdate(0, data), data.length, data.length, [data]);
    }

    // add one entry from an async generator of text chunks, deflated
    async addDeflated(name, chunkGen) {
      const cs = new CompressionStream("deflate-raw");
      const writer = cs.writable.getWriter();
      const compressed = [];
      let csize = 0;
      const reader = cs.readable.getReader();
      const pump = (async () => {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          compressed.push(value); csize += value.length;
        }
      })();
      let crc = 0, usize = 0;
      for await (const text of chunkGen) {
        const bytes = enc.encode(text);
        crc = crcUpdate(crc, bytes); usize += bytes.length;
        await writer.write(bytes);
      }
      await writer.close();
      await pump;
      this._entry(name, 8, crc, csize, usize, compressed);
      return { usize, csize };
    }

    finish() {
      const cdOff = this.offset;
      let cdSize = 0;
      for (const c of this.central) { this._push(c); cdSize += c.length; }
      const count = this.central.length;
      const z64 = this.zip64 || cdOff >= U32 || cdSize >= U32 || count >= 0xffff;
      if (z64) {
        const recOff = this.offset;
        const r = new Uint8Array(56);
        const rv = new DataView(r.buffer);
        rv.setUint32(0, 0x06064b50, true);
        setU64(rv, 4, 44);                     // size of the rest of the record
        rv.setUint16(12, 45, true); rv.setUint16(14, 45, true);
        setU64(rv, 24, count); setU64(rv, 32, count);
        setU64(rv, 40, cdSize); setU64(rv, 48, cdOff);
        this._push(r);
        const l = new Uint8Array(20);
        const lv = new DataView(l.buffer);
        lv.setUint32(0, 0x07064b50, true);
        setU64(lv, 8, recOff);
        lv.setUint32(16, 1, true);             // total number of disks
        this._push(l);
      }
      const e = new Uint8Array(22);
      const ev = new DataView(e.buffer);
      ev.setUint32(0, 0x06054b50, true);
      ev.setUint16(8, Math.min(count, 0xffff), true);
      ev.setUint16(10, Math.min(count, 0xffff), true);
      ev.setUint32(12, cdSize >= U32 ? U32 : cdSize, true);
      ev.setUint32(16, cdOff >= U32 ? U32 : cdOff, true);
      this._push(e);
      return this.chunks;
    }
  }

  const xmlEscape = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));

  /* Build a 3MF from meshes.
     meshes: [{positions: Float32Array, index: Uint32Array|null,
               map: (x,y,z) => [X,Y,Z]}]   (map applies the print transform)
     metadata: {name: value} — value strings are XML-escaped.
     Returns array of Uint8Array chunks (join into a Blob). */
  async function build3MF(meshes, metadata) {
    const zip = new ZipWriter();
    zip.addStored("[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>');
    zip.addStored("_rels/.rels",
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Target="/3D/3dmodel.model" Id="rel-1" ' +
      'Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>');

    async function* modelChunks() {
      yield '<?xml version="1.0" encoding="UTF-8"?>' +
        '<model unit="millimeter" xml:lang="en-US" ' +
        'xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">';
      for (const [k, v] of Object.entries(metadata || {}))
        yield `<metadata name="${xmlEscape(k)}">${xmlEscape(String(v))}</metadata>`;
      // ONE object holding every shell: slicers treat each 3MF object as a
      // separate movable part, and these shells (bases + welded-on
      // supports) must never be re-arranged relative to each other.
      yield '<resources><object id="1" type="model"><mesh><vertices>';
      let buf = "";
      for (const { positions, map } of meshes) {
        const nv = positions.length / 3;
        for (let i = 0; i < nv; i++) {
          const [x, y, z] = map(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
          buf += `<vertex x="${x.toFixed(3)}" y="${y.toFixed(3)}" z="${z.toFixed(3)}"/>`;
          if (buf.length > 1 << 16) { yield buf; buf = ""; }
        }
      }
      if (buf) yield buf;
      yield "</vertices><triangles>";
      buf = "";
      let vbase = 0;
      for (const { positions, index } of meshes) {
        const nv = positions.length / 3;
        const nt = index ? index.length / 3 : nv / 3;
        const ix = (k) => vbase + (index ? index[k] : k);
        for (let t = 0; t < nt; t++) {
          buf += `<triangle v1="${ix(t * 3)}" v2="${ix(t * 3 + 1)}" v3="${ix(t * 3 + 2)}"/>`;
          if (buf.length > 1 << 16) { yield buf; buf = ""; }
        }
        vbase += nv;
      }
      if (buf) yield buf;
      yield "</triangles></mesh></object></resources>" +
        '<build><item objectid="1"/></build></model>';
    }

    await zip.addDeflated("3D/3dmodel.model", modelChunks());
    return zip.finish();
  }

  root.build3MF = build3MF;
  root._zipCrc32 = (bytes) => crcUpdate(0, bytes);   // test hooks
  root._ZipWriter = ZipWriter;
})(typeof self !== "undefined" ? self : globalThis);
