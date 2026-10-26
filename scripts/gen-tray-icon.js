// 生成菜单栏模板图标（trayTemplate.png / @2x）。纯 Node 写 PNG，不引入图形库。
//
// 为什么自己画：菜单栏图标必须是**模板图**（macOS 只用其 alpha 通道，随菜单栏明暗自动
// 反色）。这里用 4× 超采样把「喷嘴 + 挤出丝 + 两层打印件」栅格化成 alpha 掩膜，
// 18pt（1x）/ 36px（2x）各出一张。
//
// 用法：node scripts/gen-tray-icon.js [输出目录]

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── 极小 PNG 编码器（RGBA8） ──
function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
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
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // deflate
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // no interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── 几何（逻辑坐标 18×18，与面板里的 SVG 同形） ──
const S = 18;

function inRect(x, y, x0, y0, x1, y1, r) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r || (x >= x0 + r && x <= x1 - r) || (y >= y0 + r && y <= y1 - r);
}

// 凸多边形内含判定（顶点按同一时针给出）。
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

// 形状表：返回 0..1 的 alpha。自下而上读作「热床 + 喷嘴 + 加热块 + 送料」。
//
// 18pt 下的可读性靠「粗细节奏」：宽热床 → 窄喷嘴 → 宽加热块 → 细丝。
// 喷嘴必须明显窄于加热块，否则两者会融成一个胶囊形，整体读成「麦克风」。
// 中间那层「正在打印的薄层」在 18px 下会糊成灰带，所以不放。
const SHAPES = [
  // 耗材丝
  (x, y) => (inRect(x, y, 8.55, 2.5, 9.45, 4.5, 0) ? 1 : 0),
  // 加热块（圆角矩形，圆角刻意小 —— 大了就成了胶囊）
  (x, y) => (inRect(x, y, 5.9, 4.5, 12.1, 8.3, 0.5) ? 1 : 0),
  // 喷嘴：上沿 3.1 宽、下沿 1.3 宽，比加热块（6.2）窄一大截，形成清晰台阶
  (x, y) => (inPoly(x, y, [[7.45, 8.3], [10.55, 8.3], [9.65, 11.2], [8.35, 11.2]]) ? 1 : 0),
  // 热床
  (x, y) => (inRect(x, y, 2.6, 13.5, 15.4, 15.5, 0.7) ? 1 : 0),
];

function render(size) {
  const px = size / S;
  const SS = 4; // 超采样
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const lx = (x + (sx + 0.5) / SS) / px;
          const ly = (y + (sy + 0.5) / SS) / px;
          let a = 0;
          for (const s of SHAPES) a = Math.max(a, s(lx, ly));
          acc += a;
        }
      }
      const alpha = Math.round((acc / (SS * SS)) * 255);
      const i = (y * size + x) * 4;
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = alpha;
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'assets'));
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'trayTemplate.png'), render(18));
fs.writeFileSync(path.join(outDir, 'trayTemplate@2x.png'), render(36));
// 放大版仅供人工核对（不当图标用）
fs.writeFileSync(path.join(outDir, '..', 'scripts', 'tray-preview.png'), render(144));
console.log('生成:', path.join(outDir, 'trayTemplate.png'), '+ @2x');
