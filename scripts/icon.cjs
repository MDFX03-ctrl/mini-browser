'use strict';

// A small code-generated application icon; no image tooling is needed to build.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const size = 256;
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}
function rounded(x, y, left, top, width, height, radius) {
  const dx = Math.max(left + radius - x, 0, x - (left + width - radius));
  const dy = Math.max(top + radius - y, 0, y - (top + height - radius));
  return x >= left && x <= left + width && y >= top && y <= top + height && dx * dx + dy * dy <= radius * radius;
}
function pixel(x, y) {
  if (!rounded(x, y, 8, 8, 240, 240, 55)) return [0, 0, 0, 0];
  let color = [52, 88, 68, 255];
  if (rounded(x, y, 45, 62, 166, 136, 18)) color = [247, 250, 238, 255];
  if (x >= 46 && x <= 210 && y >= 97 && y <= 100) color = [210, 223, 196, 255];
  for (const cx of [62, 76, 90]) if ((x - cx) ** 2 + (y - 81) ** 2 < 13) color = [143, 168, 128, 255];
  if (rounded(x, y, 106, 76, 84, 10, 4)) color = [226, 234, 214, 255];
  // Compass arrow pointing toward the upper right.
  if (x >= 96 && y >= 119 && x + y <= 280 && y <= .28 * x + 107 && y >= -.86 * x + 247) color = [74, 112, 75, 255];
  return color;
}
const raw = Buffer.alloc((size * 4 + 1) * size);
for (let y = 0; y < size; y++) {
  for (let x = 0; x < size; x++) {
    const samples = [pixel(x + .25, y + .25), pixel(x + .75, y + .25), pixel(x + .25, y + .75), pixel(x + .75, y + .75)];
    const offset = y * (size * 4 + 1) + 1 + x * 4;
    for (let c = 0; c < 4; c++) raw[offset + c] = Math.round(samples.reduce((sum, p) => sum + p[c], 0) / 4);
  }
}
const header = Buffer.alloc(13);
header.writeUInt32BE(size, 0);
header.writeUInt32BE(size, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
const icoHeader = Buffer.alloc(22);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(1, 4);
icoHeader.writeUInt16LE(1, 10);
icoHeader.writeUInt16LE(32, 12);
icoHeader.writeUInt32LE(png.length, 14);
icoHeader.writeUInt32LE(22, 18);
const directory = path.join(__dirname, '..', 'assets');
fs.mkdirSync(directory, { recursive: true });
fs.writeFileSync(path.join(directory, 'icon.png'), png);
fs.writeFileSync(path.join(directory, 'icon.ico'), Buffer.concat([icoHeader, png]));
