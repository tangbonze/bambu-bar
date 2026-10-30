// 生成应用图标（.icns）：圆角底 + 线稿龙门打印机（立柱 / X 轴横梁 / 打印头 / 喷嘴挤出 / 已成型件 / 热床）。
// 纯 Node 生成 PNG（自带 SDF 描边渲染器），再用 macOS 自带 iconutil 合成 icns。
//
// 线稿版为什么不用纯手绘 PNG：图标要 16→1024 全尺寸，位图缩放必然糊。
// 这里把图形写成「折线 + 圆角矩形」的路径表，用距离场（SDF）栅格化 —— 任意尺寸都能
// 算出干净的抗锯齿边缘，改一个坐标就是改图形，不用开设计软件。
//
// 用法：
//   node scripts/gen-app-icon.js                 # 默认 paper：浅底 + 深墨线条
//   node scripts/gen-app-icon.js brand           # brand：蓝色渐变底 + 白色线条（旧配色）
//   ICON_PREVIEW=/tmp/x.png node scripts/gen-app-icon.js brand   # 只出一张 1024 预览，不写 icns

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

// ── 距离场工具（设计坐标 100×100，y 向下） ──
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 点到线段的距离
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const qx = ax + t * dx - px;
  const qy = ay + t * dy - py;
  return Math.hypot(qx, qy);
}

// 点到折线的距离（closed 时补上收尾段）
function polyDist(px, py, pts, closed) {
  let d = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    d = Math.min(d, segDist(px, py, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]));
  }
  if (closed) {
    const a = pts[pts.length - 1];
    const b = pts[0];
    d = Math.min(d, segDist(px, py, a[0], a[1], b[0], b[1]));
  }
  return d;
}

// 圆角矩形轮廓的距离：|sdf| —— sdf<0 在内部
function rrectOutlineDist(px, py, x0, y0, x1, y1, r) {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hx = (x1 - x0) / 2 - r;
  const hy = (y1 - y0) / 2 - r;
  const qx = Math.abs(px - cx) - hx;
  const qy = Math.abs(py - cy) - hy;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return Math.abs(outside + inside - r);
}

// ── 图形：线稿龙门打印机 ──
// 坐标读法：立柱在左右、横梁在上、滑块骑在横梁上、喷嘴吐丝、丝蛇形走到底、
// 下方是已成型件、最底是热床 + 两只脚。
//
// 线宽 / 间隙是这套图形唯一要紧的节奏：线太粗，缝会糊死；太细，16px 下就会消失。
// 当前配比 ≈ 线宽 : 缝 = 1 : 1.4，接近参考图的观感。
const STROKE = 4.6;      // 主线宽（设计单位）
const STROKE_FEET = 4.2; // 脚略细

const SHAPES = [
  // 左立柱：外侧上角 45° 切角（和参考图一样，不是纯圆角）
  { type: 'poly', w: STROKE, closed: true, pts: [[11, 22], [18, 15], [25, 15], [25, 76], [11, 76]] },
  // 右立柱（镜像）
  { type: 'poly', w: STROKE, closed: true, pts: [[89, 22], [82, 15], [75, 15], [75, 76], [89, 76]] },

  // X 轴横梁：只画一条主线（参考图的双线在这个尺寸会糊成一块），滑块处断开
  { type: 'line', w: STROKE, a: [25, 20], b: [42, 20] },
  { type: 'line', w: STROKE, a: [58, 20], b: [75, 20] },

  // 打印头滑块（骑在横梁上，顶端高于立柱，靠高出那一截和横梁区分）
  { type: 'rrect', w: STROKE, x0: 42, y0: 13, x1: 58, y1: 33, r: 2 },

  // 喷嘴：上宽下尖（线宽大于开口时尖端会自然填实，和参考图一致）
  { type: 'poly', w: STROKE, closed: true, pts: [[44.2, 33], [55.8, 33], [50, 44]] },

  // 吐出的一条丝：下 → 右 → 下 → 左 → 一路落到热床（末段同时充当零件左壁）
  { type: 'poly', w: STROKE, closed: false, pts: [[50, 44], [50, 49], [64, 49], [64, 56], [36, 56], [36, 76]] },

  // 已成型件：顶面 + 右壁（左壁复用上面那条丝的末段，形成参考图里的“Γ”接法）
  { type: 'poly', w: STROKE, closed: false, pts: [[36, 65], [64, 65], [64, 76]] },

  // 热床
  { type: 'line', w: STROKE, a: [10, 78], b: [90, 78] },

  // 两只脚
  { type: 'line', w: STROKE_FEET, a: [16.5, 79], b: [16.5, 83] },
  { type: 'line', w: STROKE_FEET, a: [83.5, 79], b: [83.5, 83] },
];

// 图形的实际外接框（含线宽），用于把图形等比放进底板
const PAD = { x0: 10 - STROKE / 2, y0: 13 - STROKE / 2, x1: 90 + STROKE / 2, y1: 83 + STROKE_FEET / 2 };
const COVER = 0.83;  // 图形占底板边长的比例
const CENTER_Y = 0.503;

function makeTransform() {
  const w = PAD.x1 - PAD.x0;
  const h = PAD.y1 - PAD.y0;
  const s = COVER / Math.max(w, h);
  const ox = 0.5 - ((PAD.x0 + PAD.x1) / 2) * s;
  const oy = CENTER_Y - ((PAD.y0 + PAD.y1) / 2) * s;
  // s = 设计单位 → 底板边长；inv 把底板坐标反算回设计坐标（距离场都在设计坐标里算）
  return {
    s,
    inv: (x, y) => [(x - ox) / s, (y - oy) / s],
  };
}

// 小尺寸补偿：16/32px 下线稿的缝会糊死，按尺寸把线加粗一点
function strokeBoost(size) {
  if (size >= 256) return 1;
  if (size >= 128) return 1.06;
  if (size >= 64) return 1.18;
  if (size >= 32) return 1.45;
  return 1.35;
}

function glyphDistance(px, py, tf, boost) {
  const [dx, dy] = tf.inv(px, py);
  let d = Infinity;
  for (const shape of SHAPES) {
    let dd;
    if (shape.type === 'line') {
      dd = segDist(dx, dy, shape.a[0], shape.a[1], shape.b[0], shape.b[1]);
    } else if (shape.type === 'poly') {
      dd = polyDist(dx, dy, shape.pts, shape.closed);
    } else {
      dd = rrectOutlineDist(dx, dy, shape.x0, shape.y0, shape.x1, shape.y1, shape.r);
    }
    d = Math.min(d, dd - (shape.w * boost) / 2);
  }
  return d; // 单位：设计单位；<=0 即落在笔画上
}

const STYLES = {
  brand: {
    top: [0x3a, 0x96, 0xff],
    bottom: [0x0a, 0x5e, 0xd8],
    ink: [255, 255, 255],
  },
  paper: {
    top: [0xfd, 0xfe, 0xff],
    bottom: [0xe8, 0xed, 0xf2],
    ink: [0x23, 0x2b, 0x31],
  },
};

function renderIcon(size, styleName = 'brand') {
  const style = STYLES[styleName] || STYLES.brand;
  const rgba = Buffer.alloc(size * size * 4);
  const px = 1 / size;            // 一个像素在比例空间的长度
  const tf = makeTransform();
  const pxDesign = px / tf.s;      // 一个像素在设计坐标里的长度
  const boost = strokeBoost(size);
  const tileR = 0.225;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      // 底板：圆角方块，SDF 反推覆盖率
      const t = tileCoverage(u, v, tileR, px);
      if (t <= 0) continue;
      // 图形覆盖率
      const d = glyphDistance(u, v, tf, boost);
      const g = clamp01(0.5 - d / pxDesign);
      // 竖向渐变底：上浅下深
      const k = y / size;
      const base = [
        style.top[0] + (style.bottom[0] - style.top[0]) * k,
        style.top[1] + (style.bottom[1] - style.top[1]) * k,
        style.top[2] + (style.bottom[2] - style.top[2]) * k,
      ];
      const mixed = [
        base[0] + (style.ink[0] - base[0]) * g,
        base[1] + (style.ink[1] - base[1]) * g,
        base[2] + (style.ink[2] - base[2]) * g,
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

// 圆角方块覆盖率（0..1）：四边留白 m，圆角半径 r 为底板边长比例
function tileCoverage(u, v, r, px) {
  const m = 0.045;
  const x0 = m, y0 = m, x1 = 1 - m, y1 = 1 - m;
  const rr = r;
  const kx0 = x0 + rr, ky0 = y0 + rr, kx1 = x1 - rr, ky1 = y1 - rr;
  const qx = Math.abs(u - (x0 + x1) / 2) - ((kx1 - kx0) / 2);
  const qy = Math.abs(v - (y0 + y1) / 2) - ((ky1 - ky0) / 2);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const sd = outside + inside - rr;
  return clamp01(0.5 - sd / px);
}

const styleArg = process.argv[2] || process.env.ICON_STYLE || 'paper';
if (!STYLES[styleArg]) {
  console.error(`未知风格: ${styleArg}（可选：${Object.keys(STYLES).join(' / ')}）`);
  process.exit(1);
}

if (process.env.ICON_PREVIEW) {
  fs.writeFileSync(process.env.ICON_PREVIEW, renderIcon(1024, styleArg));
  console.log('预览:', process.env.ICON_PREVIEW);
  process.exit(0);
}

const assets = path.join(__dirname, '..', 'assets');
const iconset = path.join(assets, 'icon.iconset');
fs.mkdirSync(iconset, { recursive: true });

const SIZES = [16, 32, 64, 128, 256, 512, 1024];
const files = [];
for (const s of SIZES) {
  for (const scale of [1, 2]) {
    const pxs = s * scale;
    if (pxs > 1024) continue;
    const name = scale === 1 ? `icon_${s}x${s}.png` : `icon_${s}x${s}@2x.png`;
    const p = path.join(iconset, name);
    fs.writeFileSync(p, renderIcon(pxs, styleArg));
    files.push(p);
  }
}
fs.writeFileSync(path.join(assets, 'icon-1024.png'), renderIcon(1024, styleArg));

try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')], { stdio: 'pipe' });
  console.log('生成应用图标:', path.join(assets, 'icon.icns'), `（风格 ${styleArg}）`);
} catch (e) {
  console.warn('iconutil 失败（仍可用 PNG）:', e.message);
}
console.log('尺寸:', SIZES.join('/'), '共', files.length, '个 PNG');
