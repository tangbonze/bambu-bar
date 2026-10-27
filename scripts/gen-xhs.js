#!/usr/bin/env node
/**
 * 生成小红书规格的图文组图（1080×1440，3:4）。
 *
 * 用法：
 *   node scripts/gen-xhs.js          # 生成到 xhs/
 *   node scripts/gen-xhs.js --out=DIR
 *
 * 渲染链路：本脚本把每一页拼成一个独立 HTML（截图素材以 base64 内联，
 * 避免 file:// 下的跨源限制），再由 Chrome 无头模式离屏截图成 PNG。
 * 全程不触碰真实桌面，不需要 GUI 权限。
 *
 * 设计约束：只说 README 里已验证的事实，不做夸大表述。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const outArg = process.argv.find((a) => a.startsWith('--out='));
const outDir = path.resolve(root, outArg ? outArg.split('=')[1] : 'xhs');

const W = 1080;
const H = 1440;

/* ---------------------------------------------------------------- 素材 */

/* 轻量线性图标：全部内联 SVG，避免依赖 emoji 字体与跨平台字形差异 */
const ICON = {
  panda: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.2" cy="8.4" r="3"/><circle cx="16.8" cy="8.4" r="3"/><circle cx="12" cy="12.4" r="6.2"/><circle cx="9.8" cy="11.6" r=".9" fill="#fff" stroke="none"/><circle cx="14.2" cy="11.6" r=".9" fill="#fff" stroke="none"/><path d="M10.4 14.6h3.2"/></svg>`,
  arrow: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15"/><path d="M13 6l6 6-6 6"/></svg>`,
  play: `<svg viewBox="0 0 24 24" width="24" height="24" fill="#fff" stroke="none"><path d="M7 4.5l12 7.5-12 7.5z"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.6"/><path d="M8.2 10.5V7.6a3.8 3.8 0 0 1 7.6 0v2.9"/></svg>`,
  key: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8.6" r="4.1"/><path d="M11 11.6L20 20.6"/><path d="M16.4 17l2.4-2.4"/></svg>`,
  globe: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.2"/><path d="M3.8 12h16.4"/><path d="M12 3.8c2.2 2.3 3.3 5.2 3.3 8.2S14.2 17.9 12 20.2c-2.2-2.3-3.3-5.2-3.3-8.2S9.8 6.1 12 3.8z"/></svg>`,
  eye: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 12S6 6.4 12 6.4 21.4 12 21.4 12 18 17.6 12 17.6 2.6 12 2.6 12z"/><circle cx="12" cy="12" r="2.9"/></svg>`,
  bolt: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 2.8L4.6 13.6h6L9.8 21.2l8.6-10.8h-6z"/></svg>`,
  download: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6v11"/><path d="M7.4 10.2L12 14.8l4.6-4.6"/><path d="M4.4 19.4h15.2"/></svg>`,
  terminal: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4.6" width="18" height="14.8" rx="2.4"/><path d="M7.4 10.4l2.6 2.4-2.6 2.4"/><path d="M12.8 15.6h4"/></svg>`,
  star: `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3.4l2.7 5.5 6.1.9-4.4 4.3 1 6-5.4-2.8-5.4 2.8 1-6L3.2 9.8l6.1-.9z"/></svg>`,
  warn: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"><path d="M12 4.6v9"/><circle cx="12" cy="17.6" r="1.5" fill="#fff" stroke="none"/></svg>`,
  check: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.8 12.6l4.6 4.6L19.2 7"/></svg>`,
};

function dataUri(relPath) {
  const abs = path.join(root, relPath);
  const buf = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'application/octet-stream';
  return `data:${mime};base64,${buf.toString('base64')}`;
}

const ASSETS = {
  icon: dataUri('assets/icon-1024.png'),
  popover: dataUri('preview/popover.png'),
  popoverDark: dataUri('preview/popover-dark.png'),
  popoverDetail: dataUri('preview/popover-detail.png'),
  settingsPrinters: dataUri('preview/settings-printers.png'),
  settingsGeneral: dataUri('preview/settings-general.png'),
};

/* ---------------------------------------------------------------- 样式 */

const CSS = `
*{margin:0;padding:0;box-sizing:border-box;-webkit-font-smoothing:antialiased}
html,body{width:${W}px;height:${H}px;overflow:hidden}
body{
  font-family:"PingFang SC","Hiragino Sans GB","Heiti SC","Microsoft YaHei",sans-serif;
  background:#f4f6fa;color:#1d2129;
  display:flex;flex-direction:column;
  padding:60px 64px 52px;
  position:relative;
}
.grad{
  background:linear-gradient(160deg,#3a96ff 0%,#0a5ed8 62%,#074aad 100%);
  color:#fff;
}
.dark{background:#12141a;color:#f2f4f8}

/* 页眉 */
.top{display:flex;align-items:center;justify-content:space-between;margin-bottom:34px;flex:0 0 auto}
.brand{display:flex;align-items:center;gap:12px;font-size:24px;font-weight:700;letter-spacing:.2px}
.brand img{width:38px;height:38px;border-radius:9px;display:block}
.grad .brand img{box-shadow:0 0 0 2px rgba(255,255,255,.85)}
.brand .sub{font-weight:500;opacity:.62;font-size:20px}
.page-no{font-size:21px;font-weight:600;opacity:.5;letter-spacing:1px;font-variant-numeric:tabular-nums}
.grad .page-no,.dark .page-no{opacity:.72}

/* 主体：整块内容在页眉与页脚之间垂直居中，上下留白均衡 */
.main{flex:1;display:flex;flex-direction:column;justify-content:center;min-height:0}
.main > .stack{gap:18px}
.main > .rowfill{flex:1;min-height:0}

/* 页脚 */
.foot{
  margin-top:auto;padding-top:26px;border-top:1px solid rgba(29,33,41,.10);
  display:flex;align-items:center;justify-content:space-between;
  font-size:19px;color:#8a909c;flex:0 0 auto;
}
.grad .foot{border-top-color:rgba(255,255,255,.20);color:rgba(255,255,255,.70)}
.dark .foot{border-top-color:rgba(255,255,255,.14);color:rgba(255,255,255,.55)}
.foot .repo{font-weight:600;color:#5b6270}
.grad .foot .repo{color:rgba(255,255,255,.90)}

/* 标题块 */
.kicker{
  display:inline-flex;align-items:center;gap:9px;align-self:flex-start;
  background:rgba(10,94,216,.10);color:#0a5ed8;
  padding:9px 18px;border-radius:999px;font-size:21px;font-weight:700;
  margin-bottom:22px;
}
.grad .kicker{background:rgba(255,255,255,.18);color:#fff}
.dark .kicker{background:rgba(255,255,255,.12);color:#7fb4ff}
h1{font-size:60px;line-height:1.16;font-weight:800;letter-spacing:-.5px}
h2{font-size:52px;line-height:1.2;font-weight:800;letter-spacing:-.4px;margin-bottom:14px}
h3{font-size:31px;font-weight:750;line-height:1.32;margin-bottom:9px}
p{font-size:24px;line-height:1.62;color:#5b6270}
.grad p,.dark p{color:rgba(255,255,255,.84)}
.lead{font-size:29px;line-height:1.55;color:#39404d}
.grad .lead{color:rgba(255,255,255,.92)}
em{font-style:normal;color:#0a5ed8;font-weight:700}
.grad em{color:#8fc4ff}

/* 通用卡片 */
.card{background:#fff;border-radius:26px;padding:30px 32px;box-shadow:0 2px 18px rgba(20,30,60,.07)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.grid3{display:grid;grid-template-columns:repeat(3,1fr);gap:18px}
.stack{display:flex;flex-direction:column;gap:18px}
.row{display:flex;align-items:center;gap:18px}

/* 编号圆点 */
.num{
  width:40px;height:40px;border-radius:12px;flex:0 0 auto;
  display:flex;align-items:center;justify-content:center;
  font-size:20px;font-weight:800;color:#fff;background:#0a5ed8;
}
.num svg{display:block;flex:0 0 auto}
.num.o{background:#f5a524}.num.g{background:#17a673}.num.r{background:#e5484d}.num.v{background:#7c4dff}
.grad .num{background:rgba(255,255,255,.22)}

/* 标签 */
.tag{
  display:inline-block;background:rgba(10,94,216,.09);color:#0a5ed8;
  padding:6px 14px;border-radius:9px;font-size:19px;font-weight:650;margin:0 8px 8px 0;
}
.tag.gy{background:rgba(29,33,41,.06);color:#5b6270}
.grad .tag{background:rgba(255,255,255,.16);color:#fff}

/* 图标块 */
.ico{
  width:52px;height:52px;border-radius:15px;flex:0 0 auto;
  display:flex;align-items:center;justify-content:center;font-size:26px;
  background:rgba(10,94,216,.10);
}
.grad .ico{background:rgba(255,255,255,.18)}

/* 列表 */
ul.list{list-style:none;display:flex;flex-direction:column;gap:16px}
ul.list li{display:flex;gap:14px;font-size:23px;line-height:1.5;color:#39404d}
ul.list li b{color:#1d2129;font-weight:700}
.dot{width:9px;height:9px;border-radius:50%;background:#0a5ed8;margin-top:11px;flex:0 0 auto}

/* 引述 */
.quote{
  border-left:4px solid #0a5ed8;padding:16px 0 16px 22px;
  font-size:24px;line-height:1.6;color:#39404d;background:rgba(10,94,216,.045);
  border-radius:0 16px 16px 0;
}
.grad .quote{border-left-color:#8fc4ff;background:rgba(255,255,255,.10);color:rgba(255,255,255,.90)}

/* 截图 */
.shot{border-radius:22px;box-shadow:0 12px 40px rgba(20,30,60,.16);display:block;border:1px solid rgba(20,30,60,.07)}
.shotwrap{position:relative}
.shotcap{font-size:19px;color:#8a909c;margin-top:12px;text-align:center}

/* 标注 */
.anno{display:flex;flex-direction:column;gap:16px}
.anno .a{display:flex;gap:13px;align-items:flex-start}
.anno .a .dot{margin-top:9px}
.anno .a .txt{font-size:22px;line-height:1.5;color:#39404d}
.anno .a .txt b{color:#1d2129;font-weight:700}

/* 状态色示例 */
.swatches{display:flex;gap:14px;flex-wrap:wrap}
.sw{display:flex;align-items:center;gap:9px;font-size:20px;color:#39404d;font-weight:600}
.sw i{width:15px;height:15px;border-radius:50%;display:block}

/* 数据格 */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
.stat{background:#fff;border-radius:22px;padding:24px 22px;text-align:center;box-shadow:0 2px 16px rgba(20,30,60,.06)}
.stat b{display:block;font-size:46px;font-weight:800;color:#0a5ed8;line-height:1.1;font-variant-numeric:tabular-nums}
.stat span{display:block;font-size:19px;color:#7a808c;margin-top:8px;font-weight:600}

/* 步骤 */
.steps{display:flex;flex-direction:column;gap:0}
.step{display:flex;gap:20px;position:relative;padding-bottom:26px}
.step:last-child{padding-bottom:0}
.step .rail{width:44px;flex:0 0 auto;display:flex;flex-direction:column;align-items:center}
.step .bubble{
  width:44px;height:44px;border-radius:50%;background:#0a5ed8;color:#fff;
  display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:800;flex:0 0 auto;
}
.step .line{flex:1;width:2px;background:rgba(10,94,216,.16);margin-top:6px}
.step:last-child .line{display:none}
.step .body{flex:1;padding-top:4px}
.step .body p{font-size:21px;margin-top:4px}

/* 表格 */
table.tbl{width:100%;border-collapse:separate;border-spacing:0 10px;font-size:21px}
table.tbl td{padding:14px 18px;background:#fff}
table.tbl td:first-child{border-radius:14px 0 0 14px;font-weight:700;color:#1d2129;width:132px}
table.tbl td:last-child{border-radius:0 14px 14px 0;color:#5b6270}
`;

/* ---------------------------------------------------------------- 页面 */

function frame({ grad = false, dark = false, no, title, body, foot }) {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>${CSS}</style></head>
<body class="${grad ? 'grad' : ''} ${dark ? 'dark' : ''}">
  <div class="top">
    <div class="brand"><img src="${ASSETS.icon}" alt=""><span>Bambu Bar</span><span class="sub">菜单栏打印机状态面板</span></div>
    <div class="page-no">${String(no).padStart(2, '0')} / 08</div>
  </div>
  <div class="main">${body}</div>
  <div class="foot">
    <span>${foot || 'github.com/tangbonze/bambu-bar'}</span>
    <span class="repo">开源 · MIT</span>
  </div>
</body></html>`;
}const pages = [];

/* 01 封面 ---------------------------------------------------------- */
pages.push({
  name: '01-cover',
  html: frame({
    grad: true,
    no: 1,
    body: `
    <div style="flex:1;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding-bottom:20px">
      <div style="background:#fff;border-radius:76px;padding:26px;box-shadow:0 20px 60px rgba(0,0,0,.30)">
        <img src="${ASSETS.icon}" alt="" style="width:200px;height:200px;border-radius:48px;display:block">
      </div>
      <h1 style="font-size:88px;letter-spacing:-1.5px;margin-top:46px">Bambu Bar</h1>
      <p class="lead" style="margin-top:22px;max-width:840px">把拓竹打印机<br>塞进 macOS 菜单栏</p>
      <div style="margin-top:44px;display:flex;gap:14px;flex-wrap:wrap;justify-content:center">
        <span class="tag" style="font-size:21px;padding:11px 22px">多机自动聚合</span>
        <span class="tag" style="font-size:21px;padding:11px 22px">MQTT 实时推送</span>
        <span class="tag" style="font-size:21px;padding:11px 22px">只读 · 不下发控制</span>
      </div>
    </div>`,
    foot: '点一下图标，看清每一台机器',
  }),
});

/* 02 项目由来 ------------------------------------------------------ */
pages.push({
  name: '02-origin',
  html: frame({
    no: 2,
    body: `
    <div class="kicker">项目由来</div>
    <h2>从一只住在桌面上的熊猫开始</h2>
    <p class="lead" style="margin-bottom:34px">这个项目的起点，是另一个开源项目。</p>

    <div class="stack">
      <div class="card">
        <div class="row" style="align-items:flex-start;gap:16px">
          <div class="num o" style="margin-top:2px">${ICON.panda}</div>
          <div>
            <h3>上游：bambu-buddy</h3>
            <p style="font-size:21px">一个开源的拓竹桌面宠物 —— 打印时，桌面上有一只熊猫在动。</p>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="row" style="align-items:flex-start;gap:16px">
          <div class="num" style="margin-top:2px">${ICON.arrow}</div>
          <div>
            <h3>它的表达方式：状态 → 桌面动画</h3>
            <p style="font-size:21px">可爱，但看不到细节。你知道「在打印」，不知道「打印到第几层、还剩多久、腔温多少」。</p>
          </div>
        </div>
      </div>
      <div class="card">
        <div class="row" style="align-items:flex-start;gap:16px">
          <div class="num g" style="margin-top:2px">${ICON.play}</div>
          <div>
            <h3>我改成：状态 → 菜单栏面板</h3>
            <p style="font-size:21px">复用它的连接与解析层，把上游<em>已经解析出来、但熊猫用不上</em>的字段全部摊开。</p>
          </div>
        </div>
      </div>
    </div>

    <div class="quote" style="margin-top:26px">
      协议、状态机、MQTT 深合并都沿用上游（MIT），未改动其逻辑。<br>
      新增的是面板视图模型、菜单栏托盘层与两套界面。
    </div>`,
    foot: '上游：github.com/YingyiDai/bambu-buddy',
  }),
});

/* 03 痛点 ---------------------------------------------------------- */
pages.push({
  name: '03-problem',
  html: frame({
    no: 3,
    body: `
    <div class="kicker">为什么需要它</div>
    <h2>打印一晚上，你不想一直切 App</h2>

    <div class="stack" style="margin-top:30px">
      <div class="card row" style="align-items:center">
        <div class="num r">1</div>
        <div>
          <h3>官方 App 要退到二级页面</h3>
          <p style="font-size:21px">想看一眼进度，得点开、切页面、等它加载。</p>
        </div>
      </div>
      <div class="card row" style="align-items:center">
        <div class="num o">2</div>
        <div>
          <h3>桌宠看不出细节</h3>
          <p style="font-size:21px">动画只表达「在动」，不告诉你还剩多久、什么耗材、报了什么错。</p>
        </div>
      </div>
      <div class="card row" style="align-items:center">
        <div class="num v">3</div>
        <div>
          <h3>多台机器只能一个个点</h3>
          <p style="font-size:21px">工作室三台机 + 家里两台，来回切换才知道哪台卡住了。</p>
        </div>
      </div>
    </div>

    <div class="quote" style="margin-top:28px;font-size:26px">
      <b>解法：</b>点一下菜单栏图标，<br>
      账号下<em>所有已绑定设备</em>自动出现 —— 云端设备自动同步，不用逐个添加。
    </div>`,
    foot: '菜单栏图标就在屏幕右上角',
  }),
});

/* 04 核心界面 ------------------------------------------------------ */
pages.push({
  name: '04-ui',
  html: frame({
    no: 4,
    body: `
    <div class="kicker">核心界面</div>
    <h2 style="margin-bottom:26px">一屏看完所有机器</h2>

    <div class="rowfill" style="display:flex;gap:34px;align-items:stretch">
      <div class="shotwrap" style="flex:0 0 auto;display:flex;align-items:center">
        <img class="shot" src="${ASSETS.popover}" style="width:498px" alt="">
      </div>
      <div class="anno" style="flex:1;display:flex;flex-direction:column;justify-content:center;gap:26px;padding:6px 0">
        <div class="a"><span class="dot"></span><span class="txt"><b>面板高度跟着机器数走</b><br>一台一小条，四台四张卡；超出屏幕内部滚动，页脚始终可见</span></div>
        <div class="a"><span class="dot" style="background:#f5a524"></span><span class="txt"><b>颜色按状态取</b><br>蓝=打印中 琥珀=暂停 红=失败 绿=完成 灰=空闲</span></div>
        <div class="a"><span class="dot" style="background:#17a673"></span><span class="txt"><b>耗材是第二套颜色</b><br>AMS 与外置各带一个标签：有料亮起、没接置灰；出料槽加蓝环</span></div>
        <div class="a"><span class="dot" style="background:#e5484d"></span><span class="txt"><b>错误给的是官方口径</b><br>HMS 码 + 失败原因长句，不是「出错了」三个字</span></div>
        <div class="a"><span class="dot" style="background:#7c4dff"></span><span class="txt"><b>菜单栏直接显示进度</b><br>有机器在打印时显示平均百分比，有失败显示「!」</span></div>
      </div>
    </div>`,
    foot: '截图由真实解析链路离屏渲染，非手绘示意',
  }),
});

/* 05 功能全景 ------------------------------------------------------ */
pages.push({
  name: '05-features',
  html: frame({
    no: 5,
    body: `
    <div class="kicker">功能全景</div>
    <h2 style="margin-bottom:26px">每张卡片都摊开了什么</h2>

    <div class="stack" style="gap:14px">
      <div class="card" style="padding:22px 26px">
        <h3 style="font-size:27px">状态</h3>
        <p style="font-size:20px">打印中 / 准备中（78 种阶段精确文案）/ 换料中 / 暂停（缺料·堵头·温控异常）/ 完成 / 失败（按官方 HMS 归类）/ 离线 / 登录失效</p>
      </div>
      <div class="card" style="padding:22px 26px">
        <h3 style="font-size:27px">任务</h3>
        <p style="font-size:20px">文件名 · 进度百分比 · 当前层/总层 · 剩余时间 · <em>按本机时区算出的预计完成时刻</em>（跨自然日标 +1、+2）</p>
      </div>
      <div class="card" style="padding:22px 26px">
        <h3 style="font-size:27px">温度</h3>
        <p style="font-size:20px">喷嘴（当前/目标）· 热床（当前/目标）· 腔温（仅带腔温控制器的机型显示）</p>
      </div>
      <div class="card" style="padding:22px 26px">
        <h3 style="font-size:27px">耗材</h3>
        <p style="font-size:20px">当前耗材颜色 · AMS 各槽颜色+材料+余量 · 外置耗材单列 · AMS 内部温湿度</p>
      </div>
      <div class="card" style="padding:22px 26px">
        <h3 style="font-size:27px">机器</h3>
        <p style="font-size:20px">速度档（静音/标准/运动/狂暴+倍率）· WiFi 信号 · 喷嘴直径与材质 · 风扇 · 腔灯 · 舱门</p>
      </div>
      <div class="card" style="padding:22px 26px">
        <h3 style="font-size:27px">错误</h3>
        <p style="font-size:20px">HMS 码（16 位十六进制，悬停显示官方文案）· fail_reason 与官方原因长句</p>
      </div>
    </div>`,
    foot: '点卡片底部「详情」展开全部字段',
  }),
});

/* 06 技术细节 ------------------------------------------------------ */
pages.push({
  name: '06-detail',
  html: frame({
    no: 6,
    body: `
    <div class="kicker">技术细节</div>
    <h2 style="margin-bottom:24px">一个温度值里的讲究</h2>

    <div class="stack" style="gap:18px">
    <div class="card" style="padding:28px 30px">
      <div class="row" style="align-items:flex-start;gap:16px">
        <div class="num r" style="margin-top:2px">${ICON.warn}</div>
        <div>
          <h3>没有腔温传感器的机器，也在报腔温</h3>
          <p style="font-size:21px;margin-top:6px">A1 / P1S / P1Sc 在喷嘴 21–24°C、热床 21–22°C（即室温）时，报文里的 <code style="font-size:20px;background:rgba(29,33,41,.06);padding:2px 7px;border-radius:6px">chamber_temper</code> 全部是同一个值 <b style="color:#e5484d">5</b>。</p>
          <p style="font-size:21px;margin-top:8px">那不是测量值，是固件填的占位值 —— 直接显示就是一个假温度。</p>
        </div>
      </div>
    </div>

    <div class="card" style="padding:28px 30px">
      <div class="row" style="align-items:flex-start;gap:16px">
        <div class="num g" style="margin-top:2px">${ICON.check}</div>
        <div>
          <h3>所以按机型屏蔽，而不是按数值猜</h3>
          <p style="font-size:21px;margin-top:6px">机型清单取自 Bambu Studio 自己的机器配置 <code style="font-size:20px;background:rgba(29,33,41,.06);padding:2px 7px;border-radius:6px">support_chamber_temp_control</code> —— 切片器判断要不要显示腔温用的就是它。</p>
          <div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px">
            <span class="tag">H2C</span><span class="tag">H2D</span><span class="tag">H2D Pro</span><span class="tag">H2S</span><span class="tag">X1E</span><span class="tag">X2D</span>
            <span class="tag gy">X1 Carbon = 0</span>
          </div>
        </div>
      </div>
    </div>

    <div class="card" style="padding:28px 30px">
      <div class="row" style="align-items:flex-start;gap:16px">
        <div class="num" style="margin-top:2px">${ICON.bolt}</div>
        <div>
          <h3>新机型不用等清单更新</h3>
          <p style="font-size:21px;margin-top:6px">报文里若出现 <code style="font-size:20px;background:rgba(29,33,41,.06);padding:2px 7px;border-radius:6px">device.ctc.info.temp</code>（腔温控制器实测值），则无条件采信。</p>
        </div>
      </div>
    </div>
    </div>`,
    foot: '实现见 src/core/printer-view.js 的 resolveChamberTemp()',
  }),
});

/* 07 隐私 ---------------------------------------------------------- */
pages.push({
  name: '07-privacy',
  html: frame({
    no: 7,
    body: `
    <div class="kicker">隐私与边界</div>
    <h2 style="margin-bottom:26px">它只看，不动手</h2>

    <div class="stats" style="margin-bottom:26px">
      <div class="stat"><b>0</b><span>条控制指令</span></div>
      <div class="stat"><b>3</b><span>种连接方式</span></div>
      <div class="stat"><b>1</b><span>台打印机列表</span></div>
    </div>

    <div class="stack" style="gap:15px">
      <div class="card row" style="align-items:center;padding:24px 28px">
        <div class="num" style="margin-top:2px">${ICON.lock}</div>
        <div>
          <h3 style="font-size:27px">密码不经过本应用</h3>
          <p style="font-size:20px">浏览器登录只监听会话 cookie 里的 token，绝不注入 JS、不读表单。</p>
        </div>
      </div>
      <div class="card row" style="align-items:center;padding:24px 28px">
        <div class="num g" style="margin-top:2px">${ICON.key}</div>
        <div>
          <h3 style="font-size:27px">令牌进系统钥匙串</h3>
          <p style="font-size:20px">账号令牌与局域网访问码用 safeStorage / Keychain 加密后落盘，只在主进程内使用。</p>
        </div>
      </div>
      <div class="card row" style="align-items:center;padding:24px 28px">
        <div class="num v" style="margin-top:2px">${ICON.globe}</div>
        <div>
          <h3 style="font-size:27px">没有第三方服务器</h3>
          <p style="font-size:20px">连接只指向你自己的打印机：Bambu 云端，或局域网 IP。同一台机器同时有两种配置时优先走局域网。</p>
        </div>
      </div>
      <div class="card row" style="align-items:center;padding:24px 28px">
        <div class="num o" style="margin-top:2px">${ICON.eye}</div>
        <div>
          <h3 style="font-size:27px">只读是刻意的</h3>
          <p style="font-size:20px">面板不做任何控制：暂停 / 停止 / 调温都不做，也不扩展控制指令。</p>
        </div>
      </div>
    </div>`,
    foot: '云端·浏览器登录 / 云端·密码或验证码 / 局域网直连',
  }),
});

/* 08 获取 ---------------------------------------------------------- */
pages.push({
  name: '08-get',
  html: frame({
    grad: true,
    no: 8,
    body: `
    <div class="kicker">现在可以用了</div>
    <h2 style="font-size:56px">下载，或自己编译</h2>
    <p class="lead" style="margin-top:8px;margin-bottom:30px">开源 · MIT · Apple Silicon（arm64）</p>

    <div class="stack" style="gap:16px">
    <div class="card" style="background:rgba(255,255,255,.14);box-shadow:none;padding:28px 30px">
      <div class="row" style="align-items:flex-start;gap:16px">
        <div class="num" style="background:rgba(255,255,255,.24)">${ICON.download}</div>
        <div>
          <h3 style="font-size:29px">直接下载 DMG</h3>
          <p style="font-size:21px;color:rgba(255,255,255,.82)">Release 页已有 v1.0.0 的 dmg，双击后拖进「应用程序」。</p>
        </div>
      </div>
    </div>

    <div class="card" style="background:rgba(255,255,255,.14);box-shadow:none;padding:28px 30px">
      <div class="row" style="align-items:flex-start;gap:16px">
        <div class="num" style="background:rgba(255,255,255,.24)">${ICON.terminal}</div>
        <div>
          <h3 style="font-size:29px">没有打印机也能看</h3>
          <p style="font-size:21px;color:rgba(255,255,255,.82)">右键菜单勾「演示模式」，会起 4 台示例机，走真实解析链路。</p>
        </div>
      </div>
    </div>

    <div class="card" style="background:rgba(255,255,255,.14);box-shadow:none;padding:28px 30px">
      <div class="row" style="align-items:flex-start;gap:16px">
        <div class="num" style="background:rgba(255,255,255,.24)">${ICON.star}</div>
        <div>
          <h3 style="font-size:29px">仓库与反馈</h3>
          <p style="font-size:21px;color:rgba(255,255,255,.82);word-break:break-all">github.com/tangbonze/bambu-bar</p>
        </div>
      </div>
    </div>
    </div>

    <p style="margin-top:22px;font-size:20px;color:rgba(255,255,255,.66);text-align:center">
      未做 Apple 公证，首次打开需在「隐私与安全性」中手动放行
    </p>`,
    foot: 'Windows 上能跑，但没有托盘弹出面板的定位逻辑',
  }),
});

/* ---------------------------------------------------------------- 输出 */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function main() {
  fs.mkdirSync(outDir, { recursive: true });
  const tmpDir = path.join(outDir, '.html');
  fs.mkdirSync(tmpDir, { recursive: true });

  const written = [];
  for (const p of pages) {
    const htmlPath = path.join(tmpDir, `${p.name}.html`);
    fs.writeFileSync(htmlPath, p.html, 'utf8');
    const pngPath = path.join(outDir, `${p.name}.png`);

    execFileSync(
      CHROME,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-gpu',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--virtual-time-budget=2500',
        `--window-size=${W},${H}`,
        `--screenshot=${pngPath}`,
        `file://${htmlPath}`,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const size = fs.statSync(pngPath).size;
    written.push({ name: p.name, size });
    console.log(`✓ ${p.name}.png  ${(size / 1024).toFixed(0)} KB`);
  }

  // 拼一个联系表，方便一次看完所有页
  const sheet = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>
  body{margin:0;background:#20242c;font-family:"PingFang SC",sans-serif;padding:40px;
  display:grid;grid-template-columns:repeat(4,1fr);gap:28px}
  img{width:100%;display:block;border-radius:12px;box-shadow:0 10px 30px rgba(0,0,0,.4)}
  </style></head><body>${pages.map((p) => `<img src="${p.name}.png" alt="${p.name}">`).join('')}</body></html>`;
  fs.writeFileSync(path.join(outDir, 'contact-sheet.html'), sheet, 'utf8');

  // 中间 HTML 只是渲染中间产物，删掉
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n共 ${written.length} 张，输出到 ${outDir}`);
  console.log(`联系表：${path.join(outDir, 'contact-sheet.html')}`);
}

main();
