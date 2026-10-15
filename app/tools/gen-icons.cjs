// Minimal icon generator: writes PNG / ICO / ICNS without external deps.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.resolve(__dirname, '../src-tauri/icons');
fs.mkdirSync(OUT, { recursive: true });

// ---- CRC32 ---------------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

/** px(x, y, size) -> [r,g,b,a] */
function writePng(size, px) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = px(x, y, size);
      raw[o++] = r; raw[o++] = g; raw[o++] = b; raw[o++] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- artwork: indigo -> cyan diagonal sweep with a wind arc --------------
function pixel(x, y, size) {
  const s = size;
  const u = x / (s - 1);
  const v = y / (s - 1);
  // rounded-rect mask
  const r = s * 0.22;
  const dx = Math.min(u, 1 - u) * s;
  const dy = Math.min(v, 1 - v) * s;
  const inCorner = dx < r && dy < r ? (r - Math.hypot(r - dx, r - dy)) : r;
  const edge = Math.min(dx, dy, inCorner);
  const aa = Math.max(0, Math.min(1, edge / Math.max(1, s * 0.012)));
  if (aa <= 0) return [0, 0, 0, 0];

  const t = (u + v) / 2;
  let R = Math.round(99 + (34 - 99) * t);
  let G = Math.round(102 + (211 - 102) * t);
  let B = Math.round(241 + (238 - 241) * t);

  // three flow arcs
  const cx = 0.5, cy = 0.5;
  for (let k = 0; k < 3; k++) {
    const rad = 0.20 + k * 0.13;
    const a0 = -0.9 + k * 0.5;
    const a1 = a0 + 1.5;
    const ang = Math.atan2(v - cy, u - cx);
    const dist = Math.hypot(u - cx, v - cy);
    let na = ang < 0 ? ang + Math.PI * 2 : ang;
    let s0 = a0 < 0 ? a0 + Math.PI * 2 : a0;
    let s1 = a1 < 0 ? a1 + Math.PI * 2 : a1;
    const inArc = s1 > s0 ? na >= s0 && na <= s1 : na >= s0 || na <= s1;
    const d = Math.abs(dist - rad);
    if (inArc && d < 0.035) {
      const f = 1 - d / 0.035;
      R = Math.round(R + (255 - R) * f * 0.95);
      G = Math.round(G + (255 - G) * f * 0.95);
      B = Math.round(B + (255 - B) * f * 0.95);
    }
  }
  return [R, G, B, Math.round(aa * 255)];
}

const SIZES = [32, 128, 256, 512, 1024];
const pngs = {};
for (const s of SIZES) pngs[s] = writePng(s, pixel);

fs.writeFileSync(path.join(OUT, '32x32.png'), pngs[32]);
fs.writeFileSync(path.join(OUT, '128x128.png'), pngs[128]);
fs.writeFileSync(path.join(OUT, '128x128@2x.png'), pngs[256]);
fs.writeFileSync(path.join(OUT, 'icon.png'), pngs[1024]);
fs.writeFileSync(path.join(OUT, 'Square30x30Logo.png'), pngs[128]);
fs.writeFileSync(path.join(OUT, 'Square44x44Logo.png'), pngs[128]);
fs.writeFileSync(path.join(OUT, 'Square71x71Logo.png'), pngs[256]);
fs.writeFileSync(path.join(OUT, 'Square89x89Logo.png'), pngs[256]);
fs.writeFileSync(path.join(OUT, 'Square107x107Logo.png'), pngs[256]);
fs.writeFileSync(path.join(OUT, 'Square142x142Logo.png'), pngs[512]);
fs.writeFileSync(path.join(OUT, 'Square150x150Logo.png'), pngs[512]);
fs.writeFileSync(path.join(OUT, 'Square284x284Logo.png'), pngs[1024]);
fs.writeFileSync(path.join(OUT, 'Square310x310Logo.png'), pngs[1024]);
fs.writeFileSync(path.join(OUT, 'StoreLogo.png'), pngs[256]);

// ---- ICO (PNG-compressed entries) ---------------------------------------
function writeIco(entries) {
  const n = entries.length;
  const head = Buffer.alloc(6 + 16 * n);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2); // type: icon
  head.writeUInt16LE(n, 4);
  let off = head.length;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    head[p] = e.size >= 256 ? 0 : e.size;
    head[p + 1] = e.size >= 256 ? 0 : e.size;
    head[p + 2] = 0; // palette
    head[p + 3] = 0;
    head.writeUInt16LE(1, p + 4);  // colour planes
    head.writeUInt16LE(32, p + 6); // bpp
    head.writeUInt32LE(e.data.length, p + 8);
    head.writeUInt32LE(off, p + 12);
    off += e.data.length;
  });
  return Buffer.concat([head, ...entries.map((e) => e.data)]);
}
fs.writeFileSync(
  path.join(OUT, 'icon.ico'),
  writeIco([16, 24, 32, 48, 64, 128, 256].map((s) => ({ size: s, data: writePng(s, pixel) })))
);

// ---- ICNS ----------------------------------------------------------------
function icnsEntry(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length + 8);
  return Buffer.concat([Buffer.from(type, 'ascii'), len, data]);
}
const icnsBody = Buffer.concat([
  icnsEntry('ic07', pngs[128]),
  icnsEntry('ic08', pngs[256]),
  icnsEntry('ic09', pngs[512]),
]);
const icnsHead = Buffer.alloc(8);
icnsHead.write('icns', 0, 'ascii');
icnsHead.writeUInt32BE(icnsBody.length + 8, 4);
fs.writeFileSync(path.join(OUT, 'icon.icns'), Buffer.concat([icnsHead, icnsBody]));

console.log('icons written to', OUT);
