// 离屏预览 / 截图：用真实的解析链路（demo 报文 → state-machine → printer-view）渲染
// 面板与设置窗，再截成 PNG。窗口不透明、置于屏幕可见区域之外，不会覆盖桌面。
//
// 用法：npx electron scripts/preview-shot.js [输出目录]

const { app, BrowserWindow, ipcMain, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { resolveState } = require('../src/core/state-machine');
const { buildPrinterView, summarizeViews } = require('../src/core/printer-view');
const { t, bundle } = require('../src/config/ui-strings');
const demo = require('../src/dev/demo-data');

const argOut = process.argv.slice(2).find((a) => !a.startsWith('-') && !a.endsWith('.js'));
const OUT = path.resolve(argOut || path.join(__dirname, '..', 'preview'));
const locale = process.env.PREVIEW_LOCALE === 'en' ? 'en' : 'zh-CN';
const SUFFIX = (locale === 'en' ? '-en' : '') + (process.env.PREVIEW_DARK ? '-dark' : '');

function statusTextOf(state) {
  if (!state) return t(locale, 'tray.starting');
  const p = state.labelParams || {};
  if (p.finishedAt != null) return t(locale, 'label.finishedAt');
  return t(locale, state.labelKey, p);
}

function buildSnapshot() {
  const entries = demo.demoEntries();
  const views = entries.map((entry) => {
    const report = demo.reportFor(entry.serial);
    const state = resolveState(report);
    const v = buildPrinterView({ entry, report, state, now: Date.now(), locale });
    v.statusText = statusTextOf(state);
    return v;
  });
  return {
    mode: 'demo',
    locale,
    account: { loggedIn: true, region: 'china', account: 'tangbonze@qq.com', uid: 1234567, deviceCount: entries.length },
    summary: summarizeViews(views),
    printers: views,
    prefs: { showTrayPercent: true, panelWidth: 400 },
    lanCount: 2,
    updatedAt: Date.now(),
    emptyReason: null,
  };
}

const SNAP = buildSnapshot();

// 渲染层会 invoke 的通道，这里给最小实现（与真实主进程行为一致）
ipcMain.handle('ui:strings', () => bundle(locale));
ipcMain.handle('state:snapshot', () => SNAP);
ipcMain.handle('ui:ready', (e) => { e.sender.send('state:update', SNAP); });
ipcMain.handle('ui:height', () => true);
ipcMain.handle('app:refreshAll', () => true);
ipcMain.handle('app:refreshOne', () => true);
ipcMain.handle('app:copy', () => true);
ipcMain.handle('printer:hide', () => true);
ipcMain.handle('printer:rename', () => true);
ipcMain.handle('app:openSettings', () => true);
ipcMain.handle('app:diagnostics', () => '');
ipcMain.handle('app:quit', () => true);
ipcMain.on('popover:hide', () => {});

ipcMain.handle('settings:state', () => ({
  locale,
  account: { region: 'china', account: 'tangbonze@qq.com', uid: 1234567, loggedIn: true },
  prefs: { showTrayPercent: true, launchAtLogin: false, notify: true, pollMs: 45000, theme: process.env.PREVIEW_DARK ? 'dark' : 'system' },
  cloudPrinters: [
    { serial: demo.SERIALS.x1c, name: 'X1 Carbon', model: 'X1C', online: true, hidden: false },
    { serial: demo.SERIALS.p1s, name: '工作间 P1S', model: 'P1S', online: true, hidden: false },
    { serial: demo.SERIALS.h2d, name: 'H2D', model: 'H2D', online: false, hidden: false },
  ],
  lanPrinters: [
    { serial: demo.SERIALS.a1m, name: 'A1 mini', model: '', host: '192.168.1.57', hidden: false },
  ],
  version: require('../package.json').version,
}));
ipcMain.handle('settings:setPref', () => true);
ipcMain.handle('bambu:browserLogin', () => ({ ok: false, canceled: true }));
ipcMain.handle('bambu:login', () => ({ ok: false, error: 'x' }));
ipcMain.handle('bambu:verify', () => ({ ok: false, error: 'x' }));
ipcMain.handle('bambu:requestSmsCode', () => ({ ok: false, error: 'x' }));
ipcMain.handle('bambu:loginWithCode', () => ({ ok: false, error: 'x' }));
ipcMain.handle('bambu:completeCloudLogin', () => ({ ok: false }));
ipcMain.handle('bambu:logout', () => ({ ok: true }));
ipcMain.handle('lan:add', () => ({ ok: false }));
ipcMain.handle('lan:remove', () => true);
ipcMain.handle('window:closeSettings', () => true);
ipcMain.handle('app:revealData', () => true);

function makeWin({ width, height, file, preload, bg }) {
  return new BrowserWindow({
    width,
    height,
    x: -4000,
    y: 0,
    show: true,
    opacity: 0, // 完全透明：不会在桌面上留下任何可见覆盖物
    frame: false,
    backgroundColor: bg,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', preload),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
}

// cropTo：面板实际内容高度（CSS px）。窗口开得比内容高，截完再按内容裁掉多余空白 ——
// 这样既不会因为「改窗口高 → 面板再量」形成 resize 循环，也能得到紧凑的图。
async function shoot(win, file, waitMs = 1200, cropTo = 0) {
  await new Promise((r) => setTimeout(r, waitMs));
  let img = await win.webContents.capturePage();
  if (cropTo) {
    const scale = img.getSize().width / win.getContentSize()[0];
    img = img.crop({ x: 0, y: 0, width: img.getSize().width, height: Math.round(cropTo * scale) });
  }
  const p = path.join(OUT, file);
  fs.writeFileSync(p, img.toPNG());
  const { width, height } = img.getSize();
  console.log('saved', p, `${width}x${height}`);
}

async function panelHeight(win) {
  // 高度 = 面板自然高度 + body 上下留白（阴影已交给系统绘制，留白正常为 0，
  // 这里读计算样式而不是写死数值，改样式时截图不会错位）。
  return win.webContents.executeJavaScript(
    `(() => {
      const panel = document.getElementById('panel');
      const cs = getComputedStyle(document.body);
      const pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
      return Math.ceil(panel.getBoundingClientRect().height + pad);
    })()`,
  );
}

app.whenReady().then(async () => {
  if (process.env.PREVIEW_DARK) require('electron').nativeTheme.themeSource = 'dark';
  fs.mkdirSync(OUT, { recursive: true });
  console.log('out dir:', OUT);

  const pop = makeWin({ width: 400, height: 1200, file: '', preload: 'preload-popover.js', bg: process.env.PREVIEW_DARK ? '#1b1b1e' : '#e8e8ec' });
  await pop.loadFile(path.join(__dirname, '..', 'src', 'popover', 'index.html'));
  await new Promise((r) => setTimeout(r, 1500));
  console.log('popover loaded, panel h =', await panelHeight(pop));
  await shoot(pop, `popover${SUFFIX}.png`, 300, await panelHeight(pop));

  // PREVIEW_CAP=<px>：把窗口压到指定高度，验证「打印机太多、高度被夹紧」时
  // 面板不会被裁掉，而是列表内部滚动、页脚仍然可见。（必须在展开详情之前跑）
  if (process.env.PREVIEW_CAP) {
    const capH = Number(process.env.PREVIEW_CAP) || 360;
    pop.setContentSize(400, capH);
    await new Promise((r) => setTimeout(r, 600));
    const metrics = await pop.webContents.executeJavaScript(`(() => {
      const panel = document.getElementById('panel');
      const list = panel.querySelector('.list');
      const foot = panel.querySelector('footer');
      const fr = foot ? foot.getBoundingClientRect() : null;
      return {
        windowInner: window.innerHeight,
        panelClient: panel.clientHeight,
        listScrollable: list.scrollHeight > list.clientHeight + 1,
        listClient: list.clientHeight,
        listScroll: list.scrollHeight,
        footInsideWindow: fr ? (fr.top >= 0 && fr.bottom <= window.innerHeight + 0.5) : 'no-footer',
      };
    })()`);
    console.log('capped metrics', JSON.stringify(metrics));
    await shoot(pop, `popover-capped${SUFFIX}.png`, 300);
    pop.setContentSize(400, 1200);
    await new Promise((r) => setTimeout(r, 400));
  }

  // PREVIEW_HOVER=1：回归断言「悬停不会改变面板高度」。
  // 操作行现在常驻（不靠 :hover 显隐），这条检查因此变成守门用：
  // 一旦有人重新加回 `.card:hover { ... }` 之类的布局规则，delta 就不再是 0，
  // 鼠标扫过卡片时窗口会抖动。这里注入一条把操作行强制可见的样式作为扰动源，
  // 等价于「鼠标停在卡片上」，然后比较前后高度。delta 必须为 0。
  if (process.env.PREVIEW_HOVER) {
    const before = await panelHeight(pop);
    const cardH0 = await pop.webContents.executeJavaScript(
      "Math.ceil(document.querySelector('.card').getBoundingClientRect().height)",
    );
    await pop.webContents.insertCSS('#panel .card .card-actions { opacity: 1 !important; }');
    await new Promise((r) => setTimeout(r, 400));
    const after = await panelHeight(pop);
    const cardH1 = await pop.webContents.executeJavaScript(
      "Math.ceil(document.querySelector('.card').getBoundingClientRect().height)",
    );
    console.log('hover metrics', JSON.stringify({ before, after, cardH0, cardH1, delta: after - before }));
    await shoot(pop, `popover-hover${SUFFIX}.png`, 300, after);
  }

  // 展开第一张卡片的详情，再截一张（验证详情区排版）
  await pop.webContents.executeJavaScript(`
    (() => {
      const btn = document.querySelector('.card .mini-btn');
      if (btn) btn.click();
    })()
  `);
  await shoot(pop, `popover-detail${SUFFIX}.png`, 900, await panelHeight(pop));

  const set = makeWin({ width: 720, height: 600, file: '', preload: 'preload-settings.js', bg: process.env.PREVIEW_DARK ? '#18181b' : '#f5f5f7' });
  await set.loadFile(path.join(__dirname, '..', 'src', 'settings', 'index.html'), { hash: 'printers' });
  await shoot(set, `settings-printers${SUFFIX}.png`, 1200);

  await set.loadFile(path.join(__dirname, '..', 'src', 'settings', 'index.html'), { hash: 'account' });
  await shoot(set, `settings-account${SUFFIX}.png`, 1200);

  await set.loadFile(path.join(__dirname, '..', 'src', 'settings', 'index.html'), { hash: 'general' });
  await shoot(set, `settings-general${SUFFIX}.png`, 1200);

  app.quit();
}).catch((e) => { console.error('preview failed:', e); app.exit(1); });

setTimeout(() => { console.error('preview timeout'); app.exit(2); }, 45000);
