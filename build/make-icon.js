// =============================================================================
// make-icon.js — Dibuja build/icon.png (256x256): el mismo mini Clawd de la
// bandeja (main.js → trayIcon) agrandado 16 veces. Sin dependencias: arma el
// PNG a mano con zlib. Se corre solo con `npm run dist` (ver package.json).
// =============================================================================
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROWS = [
  '................',
  '................',
  '................',
  '..############..',
  '..############..',
  '#####.####.#####',
  '#####.####.#####',
  '..############..',
  '..############..',
  '..############..',
  '...#.#....#.#...',
  '...#.#....#.#...',
  '...#.#....#.#...',
  '................',
  '................',
  '................',
];
const SCALE = 16, SIZE = 16 * SCALE;
const ORANGE = [0xd9, 0x77, 0x57, 0xff];

// Cada fila del PNG empieza con un byte de "filtro" (0 = ninguno) + RGBA por píxel.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const row = y * (SIZE * 4 + 1);
  for (let x = 0; x < SIZE; x++) {
    if (ROWS[Math.floor(y / SCALE)][Math.floor(x / SCALE)] === '#') raw.set(ORANGE, row + 1 + x * 4);
  }
}

// CRC32, el chequeo que lleva cada bloque del PNG.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8 bits por canal, RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
console.log('build/icon.png listo');
