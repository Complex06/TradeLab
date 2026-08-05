// Generates public/icon-*.png (192 / 512 / maskable 512) with a plain Node
// PNG encoder — no canvas dependency needed.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const outDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function png(size, { maskable = false } = {}) {
  // Background: #0b0e14 rounded-ish square (full square is fine for icons).
  const bg = [11, 14, 20, 255];
  const line = [34, 197, 94, 255]; // green #22c55e
  const pad = maskable ? Math.floor(size * 0.15) : 0;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    row[0] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const i = 1 + x * 4;
      // Background circle (safe area). Inside it the candle/line.
      const cx = size / 2, cy = size / 2;
      const r = size / 2 - Math.max(pad * 0.4, 4);
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const inside = dx * dx + dy * dy <= r * r;
      if (!inside) {
        row[i] = 0; row[i + 1] = 0; row[i + 2] = 0; row[i + 3] = 0;
        continue;
      }
      row[i] = bg[0]; row[i + 1] = bg[1]; row[i + 2] = bg[2]; row[i + 3] = bg[3];
      // Draw a simple rising polyline of green dots.
      const pts = [
        [0.18, 0.66], [0.38, 0.42], [0.52, 0.55], [0.68, 0.30], [0.82, 0.42],
      ];
      for (const [px, py] of pts) {
        const pxX = Math.round(px * size), pxY = Math.round(py * size);
        const d = Math.hypot(x - pxX, y - pxY);
        if (d <= Math.max(size * 0.02, 2)) {
          row[i] = line[0]; row[i + 1] = line[1]; row[i + 2] = line[2]; row[i + 3] = line[3];
        }
      }
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.concat(rows);
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(resolve(outDir, 'icon-192.png'), png(192));
writeFileSync(resolve(outDir, 'icon-512.png'), png(512));
writeFileSync(resolve(outDir, 'icon-maskable-512.png'), png(512, { maskable: true }));
console.log('icons written to public/');
