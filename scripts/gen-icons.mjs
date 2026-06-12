// Renders the app icons: blue gradient tile with a white tick.
// Minimal PNG encoder, no dependencies.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(outDir, { recursive: true });

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Tick geometry in unit coordinates
const TICK = [
  [0.30, 0.535],
  [0.445, 0.675],
  [0.715, 0.375],
];
const TICK_WIDTH = 0.082;

function distToSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)));
  const cx = ax + t * abx, cy = ay + t * aby;
  return Math.hypot(px - cx, py - cy);
}

function tickDist(u, v) {
  return Math.min(
    distToSegment(u, v, ...TICK[0], ...TICK[1]),
    distToSegment(u, v, ...TICK[1], ...TICK[2]),
  );
}

const lerp = (a, b, t) => a + (b - a) * t;

function renderIcon(size, { transparent = false } = {}) {
  const SS = 3; // supersampling
  const rgba = Buffer.alloc(size * size * 4);
  const radius = TICK_WIDTH / 2;

  // gradient stops: deep blue -> bright blue, diagonal
  const c0 = [0x1e, 0x40, 0xaf];
  const c1 = [0x3b, 0x82, 0xf6];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let rs = 0, gs = 0, bs = 0, as = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;

          // tick coverage with soft edge (~0.75px at target size)
          const d = tickDist(u, v) - radius;
          const edge = 0.75 / size;
          const tick = Math.max(0, Math.min(1, 1 - (d / edge + 1) / 2 + 0.5));

          if (transparent) {
            rs += 255 * tick; gs += 255 * tick; bs += 255 * tick; as += 255 * tick;
          } else {
            const t = (u + v) / 2;
            let r = lerp(c0[0], c1[0], t);
            let g = lerp(c0[1], c1[1], t);
            let b = lerp(c0[2], c1[2], t);
            // subtle top-left sheen
            const sheen = Math.max(0, 0.10 - Math.hypot(u - 0.25, v - 0.2) * 0.18);
            r = Math.min(255, r + 255 * sheen);
            g = Math.min(255, g + 255 * sheen);
            b = Math.min(255, b + 255 * sheen);
            rs += lerp(r, 255, tick);
            gs += lerp(g, 255, tick);
            bs += lerp(b, 255, tick);
            as += 255;
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(rs / n);
      rgba[i + 1] = Math.round(gs / n);
      rgba[i + 2] = Math.round(bs / n);
      rgba[i + 3] = Math.round(as / n);
    }
  }
  return png(size, size, rgba);
}

writeFileSync(join(outDir, 'icon-512.png'), renderIcon(512));
writeFileSync(join(outDir, 'icon-192.png'), renderIcon(192));
writeFileSync(join(outDir, 'apple-touch-icon.png'), renderIcon(180));
writeFileSync(join(outDir, 'badge-96.png'), renderIcon(96, { transparent: true }));
console.log('icons written to', outDir);
