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
  const le16 = (v) => [v & 0xff, (v >> 8) & 0xff];
  const le32 = (v) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];

  // ---- minimal ZIP writer -------------------------------------------------
  // Entries are written sequentially; the model entry streams through
  // deflate-raw. Uses data descriptors (flag bit 3) so sizes/CRC follow the
  // payload. Central directory written at the end.
  class ZipWriter {
    constructor() { this.chunks = []; this.offset = 0; this.central = []; }
    _push(u8) { this.chunks.push(u8); this.offset += u8.length; }

    _localHeader(name, method) {
      const n = enc.encode(name);
      const h = new Uint8Array(30 + n.length);
      h.set([0x50, 0x4b, 0x03, 0x04]);
      h.set(le16(20), 4);            // version
      h.set(le16(0x08), 6);          // flags: data descriptor
      h.set(le16(method), 8);        // 0 stored / 8 deflate
      h.set(le16(n.length), 26);
      h.set(n, 30);
      return h;
    }
    _descriptor(crc, csize, usize) {
      const d = new Uint8Array(16);
      d.set([0x50, 0x4b, 0x07, 0x08]);
      d.set(le32(crc), 4); d.set(le32(csize), 8); d.set(le32(usize), 12);
      return d;
    }
    _centralRecord(name, method, crc, csize, usize, off) {
      const n = enc.encode(name);
      const c = new Uint8Array(46 + n.length);
      c.set([0x50, 0x4b, 0x01, 0x02]);
      c.set(le16(20), 4); c.set(le16(20), 6);
      c.set(le16(0x08), 8); c.set(le16(method), 10);
      c.set(le32(crc), 16); c.set(le32(csize), 20); c.set(le32(usize), 24);
      c.set(le16(n.length), 28);
      c.set(le32(off), 42);
      c.set(n, 46);
      return c;
    }

    addStored(name, text) {
      const data = enc.encode(text);
      const off = this.offset;
      this._push(this._localHeader(name, 0));
      this._push(data);
      const crc = crcUpdate(0, data);
      this._push(this._descriptor(crc, data.length, data.length));
      this.central.push(this._centralRecord(name, 0, crc, data.length, data.length, off));
    }

    // add one entry from an async generator of text chunks, deflated
    async addDeflated(name, chunkGen) {
      const off = this.offset;
      this._push(this._localHeader(name, 8));
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
      for (const c of compressed) this._push(c);
      this._push(this._descriptor(crc, csize, usize));
      this.central.push(this._centralRecord(name, 8, crc, csize, usize, off));
      return { usize, csize };
    }

    finish() {
      const cdOff = this.offset;
      let cdSize = 0;
      for (const c of this.central) { this._push(c); cdSize += c.length; }
      const e = new Uint8Array(22);
      e.set([0x50, 0x4b, 0x05, 0x06]);
      e.set(le16(this.central.length), 8);
      e.set(le16(this.central.length), 10);
      e.set(le32(cdSize), 12); e.set(le32(cdOff), 16);
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
  root._zipCrc32 = (bytes) => crcUpdate(0, bytes);   // test hook
})(typeof self !== "undefined" ? self : globalThis);
