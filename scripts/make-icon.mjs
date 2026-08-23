// Generates resources/icon.png (128x128) — a git graph glyph, no external deps.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SIZE = 128;
const BG = [30, 30, 30, 255];          // #1e1e1e
const LANE_A = [79, 193, 255, 255];    // #4fc1ff blue
const LANE_B = [106, 153, 85, 255];    // #6a9955 green
const EDGE = [215, 186, 125, 255];     // #d7ba7d gold

// RGBA canvas
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let i = 0; i < SIZE * SIZE; i++) px.set(BG, i * 4);

function set(x, y, rgba, alpha = 1) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const o = (y * SIZE + x) * 4;
  for (let c = 0; c < 3; c++) {
    px[o + c] = Math.round(px[o + c] * (1 - alpha) + rgba[c] * alpha);
  }
  px[o + 3] = 255;
}

function disc(cx, cy, r, rgba) {
  const r2 = r * r;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= r2) set(x, y, rgba);
      else if (d2 <= (r + 1) ** 2) set(x, y, rgba, 0.45); // cheap AA
    }
  }
}

function ring(cx, cy, r, w, rgba) {
  const outer = (r + w / 2) ** 2;
  const inner = (r - w / 2) ** 2;
  for (let y = Math.floor(cy - r - w); y <= Math.ceil(cy + r + w); y++) {
    for (let x = Math.floor(cx - r - w); x <= Math.ceil(cx + r + w); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 <= outer && d2 >= inner) set(x, y, rgba);
    }
  }
}

function segment(x0, y0, x1, y1, w, rgba) {
  const steps = Math.ceil(Math.hypot(x1 - x0, y1 - y0) * 2);
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    disc(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, w / 2, rgba);
  }
}

function curve(x0, y0, cx, cy, x1, y1, w, rgba) {
  const steps = 220;
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    const mt = 1 - t;
    const x = mt * mt * x0 + 2 * mt * t * cx + t * t * x1;
    const y = mt * mt * y0 + 2 * mt * t * cy + t * t * y1;
    disc(x, y, w / 2, rgba);
  }
}

const LANE_X = 42;
const BRANCH_X = 86;
const LINE_W = 6;
const NODE_R = 9;

// main lane
segment(LANE_X, 20, LANE_X, 108, LINE_W, LANE_A);
// branch lane
segment(BRANCH_X, 54, BRANCH_X, 82, LINE_W, LANE_B);
// branch out / merge back
curve(LANE_X, 44, LANE_X + 26, 44, BRANCH_X, 56, 5, EDGE);
curve(BRANCH_X, 80, LANE_X + 26, 94, LANE_X, 94, 5, EDGE);

// nodes on main lane
for (const y of [22, 44, 94, 106]) disc(LANE_X, y, NODE_R, LANE_A);
// merge node drawn as ring so it reads as a merge commit
ring(LANE_X, 68, NODE_R - 1, 5, LANE_A);
// nodes on branch lane
for (const y of [56, 80]) disc(BRANCH_X, y, NODE_R - 1, LANE_B);

// ---- PNG encode (RGBA, 8-bit, no interlace) ----
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // color type RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // filter
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = resolve(process.argv[2] ?? 'resources/icon.png');
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes, ${SIZE}x${SIZE})`);
