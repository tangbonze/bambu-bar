// 生成应用图标（.icns）：蓝色圆角方块 + 白色挤出机图形，与菜单栏图标同一套几何。
// 纯 Node 生成 PNG（复用 gen-tray-icon 的 PNG 编码器），再用 macOS 自带 iconutil 合成 icns。
//
// 用法：node scripts/gen-app-icon.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// ── PNG 编码（RGBA8） ──
function crc32(buf) {
  let c;
  const table = crc32.t || (crc32.t = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })());
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 几何 ──
function roundedRectTest(x0, y0, x1, y1, r) {
  return (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    const cx = Math.min(Math.max(x, x0 + r), x1 - r);
    const cy = Math.min(Math.max(y, y0 + r), y1 - r);
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
      || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
  };
}
function inPoly(x, y, pts) {
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
    if (cross !== 0) {
      const s = cross > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
  }
  return true;
}

// 白色图形：与菜单栏图标同一套几何（18 单位坐标系，内容居中于 9,9），整体等比缩放。
const SC = 0.80;   // 图形高度占图标高度的比例
const tf = (u, v) => [(u - 0.5) * 18 / SC + 9, (v - 0.5) * 18 / SC + 9];

function inRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
    || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}

const GLYPH_18 = [
  // 耗材丝
  (x, y) => inRect(x, y, 8.55, 2.5, 9.45, 4.5, 0),
  // 加热块
  (x, y) => inRect(x, y, 5.9, 4.5, 12.1, 8.3, 0.5),
  // 喷嘴（明显窄于加热块，形成台阶）
  (x, y) => inPoly(x, y, [[7.45, 8.3], [10.55, 8.3], [9.65, 11.2], [8.35, 11.2]]),
  // 热床
  (x, y) => inRect(x, y, 2.6, 13.5, 15.4, 15.5, 0.7),
];

const GLYPH = GLYPH_18.map((fn) => (u, v) => {
  const [x, y] = tf(u, v);
  return fn(x, y) ? 1 : 0;
});

function renderIcon(size) {
  const rgba = Buffer.alloc(size * size * 4);
  const SS = 4;
  const tile = roundedRectTest(0.045, 0.045, 0.955, 0.955, 0.225);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let tileCov = 0;
      let glyphCov = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          if (tile(u, v)) tileCov += 1;
          let g = 0;
          for (const s of GLYPH) g = Math.max(g, s(u, v));
          glyphCov += g;
        }
      }
      const t = tileCov / (SS * SS);
      const g = Math.min(1, glyphCov / (SS * SS));
      // 竖向渐变蓝底：上浅下深
      const k = y / size;
      const r0 = 0x3a, g0 = 0x96, b0 = 0xff;
      const r1 = 0x0a, g1 = 0x5e, b1 = 0xd8;
      const base = [r0 + (r1 - r0) * k, g0 + (g1 - g0) * k, b0 + (b1 - b0) * k];
      const mixed = [
        base[0] + (255 - base[0]) * g,
        base[1] + (255 - base[1]) * g,
        base[2] + (255 - base[2]) * g,
      ];
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(mixed[0]);
      rgba[i + 1] = Math.round(mixed[1]);
      rgba[i + 2] = Math.round(mixed[2]);
      rgba[i + 3] = Math.round(t * 255);
    }
  }
  return encodePng(size, size, rgba);
}

const assets = path.join(__dirname, '..', 'assets');
const iconset = path.join(assets, 'icon.iconset');
fs.mkdirSync(iconset, { recursive: true });

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const files = [];
for (const s of SIZES) {
  for (const scale of [1, 2]) {
    const px = s * scale;
    if (px > 1024) continue;
    const name = scale === 1 ? `icon_${s}x${s}.png` : `icon_${s}x${s}@2x.png`;
    const p = path.join(iconset, name);
    fs.writeFileSync(p, renderIcon(px));
    files.push(p);
  }
}
fs.writeFileSync(path.join(assets, 'icon-1024.png'), renderIcon(1024));

try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')], { stdio: 'pipe' });
  console.log('生成应用图标:', path.join(assets, 'icon.icns'));
} catch (e) {
  console.warn('iconutil 失败（仍可用 PNG）:', e.message);
}
console.log('尺寸:', SIZES.join('/'), '共', files.length, '个 PNG');
