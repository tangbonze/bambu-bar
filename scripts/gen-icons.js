// 生成两套图标，共用一份「Bambu 标记 + 小齿轮」母题：
//   · assets/trayTemplate.png / @2x   —— 菜单栏模板图（macOS 只用 alpha，随明暗自动反色）
//   · assets/icon.icns / icon-1024.png —— 应用图标（拓竹绿底板 + 白色标记 + 齿轮角标）
//
// 标记（两根竖条 + 中间那道闪电形折缝）不靠手绘还原：它是从 Bambu Studio 自带的
// Icon.icns 里抠出来的真实像素蒙版，存成 assets/bambu-mark.png（370×482，白/alpha）。
// 手绘版在 18px 下会出现「条宽对、缝宽错」的偏差，而缝宽恰恰是这个标记最认得出的特征。
//
// 用法：node scripts/gen-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

// ─────────────────────────── PNG 编解码 ───────────────────────────
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

/** 只支持 8 位 RGBA / RGB 的非隔行 PNG —— 够读我们自己抠出来的蒙版。 */
function decodePng(file) {
  const d = fs.readFileSync(file);
  let pos = 8;
  let w = 0, h = 0, ct = 6;
  const idat = [];
  while (pos < d.length) {
    const len = d.readUInt32BE(pos);
    const type = d.toString('ascii', pos + 4, pos + 8);
    const body = d.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      w = body.readUInt32BE(0);
      h = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('只支持 8 位非隔行 PNG');
      ct = body[9];
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const nch = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  const stride = w * nch;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const line = Buffer.from(raw.subarray(p, p + stride));
    p += stride;
    if (f === 1) for (let i = nch; i < stride; i++) line[i] = (line[i] + line[i - nch]) & 255;
    else if (f === 2) for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 255;
    else if (f === 3) {
      for (let i = 0; i < stride; i++) {
        const a = i >= nch ? line[i - nch] : 0;
        line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255;
      }
    } else if (f === 4) {
      for (let i = 0; i < stride; i++) {
        const a = i >= nch ? line[i - nch] : 0;
        const b = prev[i];
        const c = i >= nch ? prev[i - nch] : 0;
        const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
        const pr = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
        line[i] = (line[i] + pr) & 255;
      }
    }
    line.copy(out, y * stride);
    prev = line;
  }
  return { w, h, nch, data: out };
}

// ─────────────────────────── 标记蒙版 ───────────────────────────
const markPng = decodePng(path.join(__dirname, '..', 'assets', 'bambu-mark.png'));
const MARK_W = markPng.w;
const MARK_H = markPng.h;
const MARK = new Float32Array(MARK_W * MARK_H);
for (let i = 0; i < MARK_W * MARK_H; i++) {
  MARK[i] = markPng.nch === 4 ? markPng.data[i * 4 + 3] / 255 : 0;
}

/** 双线性采样标记的覆盖率（u,v 归一化到 0..1）。大尺寸缩小用这个，边缘平滑。 */
function markAt(u, v) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const fx = Math.min(MARK_W - 1.001, Math.max(0, u * (MARK_W - 1)));
  const fy = Math.min(MARK_H - 1.001, Math.max(0, v * (MARK_H - 1)));
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const i00 = MARK[y0 * MARK_W + x0];
  const i10 = MARK[y0 * MARK_W + x0 + 1];
  const i01 = MARK[(y0 + 1) * MARK_W + x0];
  const i11 = MARK[(y0 + 1) * MARK_W + x0 + 1];
  return (i00 * (1 - tx) + i10 * tx) * (1 - ty) + (i01 * (1 - tx) + i11 * tx) * ty;
}

/**
 * 最近邻采样。菜单栏 18px 用这个：外层已经在做 6×6 超采样（等于面积平均），
 * 每个子样本再插值一次只会多叠一层模糊，把本来就只剩 1px 的折缝糊掉。
 */
function markAtNearest(u, v) {
  if (u < 0 || u > 1 || v < 0 || v > 1) return 0;
  const x = Math.min(MARK_W - 1, Math.max(0, Math.round(u * (MARK_W - 1))));
  const y = Math.min(MARK_H - 1, Math.max(0, Math.round(v * (MARK_H - 1))));
  return MARK[y * MARK_W + x];
}

// ─────────────────────────── 齿轮 ───────────────────────────
// 8 齿梯形齿 + 中心孔。齿顶占 36% 弧长、齿根 64%，靠一段平滑过渡避免抗锯齿出现台阶。
// 只在应用图标（1024）里出现 —— 菜单栏那枚是纯标记，不叠齿轮。
const GEAR = {
  teeth: 8,
  rootR: 0.75,    // 齿根半径 / 外半径
  holeR: 0.27,    // 中心孔半径 / 外半径
  topHalf: 0.18,  // 齿顶半弧（占一个齿距的比例）
  rootHalf: 0.32, // 齿根半弧（占一个齿距的比例）
};

const smoothstep = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/** 齿轮在 (dx,dy) 处的覆盖率；R 为外半径。 */
function gearAt(dx, dy, R) {
  const r = Math.hypot(dx, dy);
  if (r > R) return 0;
  if (r < R * GEAR.holeR) return 0;
  if (r <= R * GEAR.rootR) return 1;
  // 在齿根环之外，只有落在齿顶弧内才算数
  let ang = Math.atan2(dy, dx) / (Math.PI * 2);
  if (ang < 0) ang += 1;
  const ph = (ang * GEAR.teeth) % 1;
  const d = Math.min(ph, 1 - ph); // 到最近齿中心的距离
  if (d > GEAR.rootHalf) return 0;
  // 齿侧壁：从 rootHalf 平滑收到 topHalf，给出梯形而非矩形齿
  const k = 1 - smoothstep((d - GEAR.topHalf) / (GEAR.rootHalf - GEAR.topHalf));
  const limit = R * (GEAR.rootR + (1 - GEAR.rootR) * k);
  return r <= limit ? 1 : 0;
}

// ─────────────────────────── 版面 ───────────────────────────
// 菜单栏那枚（18 单位坐标系）：只有标记本身，不放齿轮。
// macOS 的模板图只有一个颜色通道、且实际只用 11–17pt，叠一个 6px 的齿轮进去只会
// 变成一团噪点 —— 齿轮留给 1024 的应用图标。
const TRAY = {
  size: 18,
  markH: 16.2,   // 撑满高度（留 0.9 上下边），原图比例 370:482
  markY: 0.9,
};

function renderTray(size, ss = 6) {
  const px = size / TRAY.size;
  const markW = TRAY.markH * (MARK_W / MARK_H);
  const markX = (TRAY.size - markW) / 2;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let acc = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const lx = (x + (sx + 0.5) / ss) / px;
          const ly = (y + (sy + 0.5) / ss) / px;
          acc += markAtNearest((lx - markX) / markW, (ly - TRAY.markY) / TRAY.markH);
        }
      }
      const a = Math.round((acc / (ss * ss)) * 255);
      const i = (y * size + x) * 4;
      rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0; rgba[i + 3] = a;
    }
  }
  return encodePng(size, size, rgba);
}

// 应用图标：拓竹绿圆角底板 + 居中白色标记 + 右下角齿轮。
// 齿轮与标记**刻意相交**：两者同为白色，max() 混合后自然连成一体，
// 读起来是「一台装好齿轮的打印机」而不是「图标旁边贴了个齿轮」。
// 标记高度取 47%（与 Bambu Studio 自身 icon 一致：482/1024），底板内缩与圆角也照它的比例。
const GREEN = [0x00, 0xae, 0x42];

function renderApp(size, ss = 4) {
  const rgba = Buffer.alloc(size * size * 4);
  const plate = { x0: 0.045, y0: 0.045, x1: 0.955, y1: 0.955, r: 0.225 };
  // 标记高度 50%（Studio 原版 47%），齿轮半径 0.175（直径 = 标记高度的 70%）。
  // 圆心离标记右下角 0.136，半径 0.175 → 圆边只切进标记 0.04（标记高度的 8%）：
  // 「咬合」而不是「吞掉」，齿轮八个齿基本都能看见，交点处两者连成一体。
  // 齿轮外缘 0.895，距底板内边 0.955 留 0.06；标记上边距 0.105、左边距 0.175。
  const markH = 0.50;
  const markW = markH * (MARK_W / MARK_H);
  const markX = 0.22;
  const markY = 0.15;
  const gearC = 0.72;
  const gearR = 0.175;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let cov = 0, glyph = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const u = (x + (sx + 0.5) / ss) / size;
          const v = (y + (sy + 0.5) / ss) / size;
          if (inRounded(u, v, plate)) cov += 1;
          const m = markAt((u - markX) / markW, (v - markY) / markH);
          const g = gearAt(u - gearC, v - gearC, gearR);
          glyph += Math.max(m, g);
        }
      }
      const t = cov / (ss * ss);
      const g = Math.min(1, glyph / (ss * ss));
      const i = (y * size + x) * 4;
      for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(GREEN[k] + (255 - GREEN[k]) * g);
      rgba[i + 3] = Math.round(t * 255);
    }
  }
  return encodePng(size, size, rgba);
}

function inRounded(u, v, p) {
  if (u < p.x0 || u > p.x1 || v < p.y0 || v > p.y1) return false;
  const cx = Math.min(Math.max(u, p.x0 + p.r), p.x1 - p.r);
  const cy = Math.min(Math.max(v, p.y0 + p.r), p.y1 - p.r);
  return (u - cx) ** 2 + (v - cy) ** 2 <= p.r * p.r
    || (u >= p.x0 + p.r && u <= p.x1 - p.r) || (v >= p.y0 + p.r && v <= p.y1 - p.r);
}

// ─────────────────────────── 输出 ───────────────────────────
const assets = path.join(__dirname, '..', 'assets');
fs.mkdirSync(assets, { recursive: true });

fs.writeFileSync(path.join(assets, 'trayTemplate.png'), renderTray(18));
fs.writeFileSync(path.join(assets, 'trayTemplate@2x.png'), renderTray(36));
fs.writeFileSync(path.join(__dirname, 'tray-preview.png'), renderTray(144));

const iconset = path.join(assets, 'icon.iconset');
fs.mkdirSync(iconset, { recursive: true });
const SIZES = [16, 32, 64, 128, 256, 512, 1024];
let n = 0;
for (const s of SIZES) {
  for (const scale of [1, 2]) {
    const pxs = s * scale;
    if (pxs > 1024) continue;
    const name = scale === 1 ? `icon_${s}x${s}.png` : `icon_${s}x${s}@2x.png`;
    fs.writeFileSync(path.join(iconset, name), renderApp(pxs));
    n += 1;
  }
}
fs.writeFileSync(path.join(assets, 'icon-1024.png'), renderApp(1024));

try {
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', path.join(assets, 'icon.icns')], { stdio: 'pipe' });
  console.log('✓ icon.icns');
} catch (e) {
  console.warn('iconutil 失败（PNG 仍可用）:', e.message);
}
console.log('✓ trayTemplate.png / @2x，应用图标', n, '个尺寸');
