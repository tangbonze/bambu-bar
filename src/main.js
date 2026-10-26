// Bambu Bar — 主进程。
//
// 职责边界（与上游 bambu-buddy 一致的分层）：
//   · 连接与生命周期：PrinterHub（云端 MQTT / 局域网 MQTT / 云端 REST 轮询）
//   · 报文 → 状态：core/state-machine（含去抖、完成态、官方错误码归类）
//   · 状态 → 视图：core/printer-view（本应用新增，把面板要的字段一次算清）
//   · 本文件：托盘图标 / 弹出面板 / 设置窗 / IPC / 通知 / 偏好持久化

const {
  app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, nativeTheme,
  safeStorage, shell, session, clipboard, Notification,
} = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const { resolveState, isPrintActive } = require('./core/state-machine');
const { applyCompletionState } = require('./core/completion-state');
const { StateStabilizer } = require('./core/state-stabilizer');
const { shouldRefreshOnColorLoss } = require('./core/filament-refresh');
const { BambuCloudDataSource, BambuLanDataSource, classifyLanProbe } = require('./core/bambu-mqtt');
const bambuAuth = require('./core/bambu-auth');
const browserLogin = require('./core/browser-login');
const registry = require('./core/printer-registry');
const { PrinterHub } = require('./core/printer-hub');
const errorCodes = require('./core/bambu-error-codes');
const { buildPrinterView, summarizeViews } = require('./core/printer-view');
const { t, bundle } = require('./config/ui-strings');
const { STRINGS } = require('./config/locales');

const DEV = process.argv.includes('--dev');

app.setName('Bambu Bar');

// 单实例：菜单栏应用重复启动只会多出一个看不见的图标。
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const store = new Store({
  defaults: {
    locale: 'zh-CN',
    dataSource: 'live',
    demoMode: false,
    bambuAccount: null,
    bambuPrinters: [],
    bambuLanPrinters: [],
    hiddenPrinters: [],
    printCompletionHistory: {},
    showTrayPercent: true,
    launchAtLogin: false,
    notify: true,
    pollMs: 45000,
    panelWidth: 400,
    // 外观：'system' 跟随 macOS，'light' / 'dark' 强制。写进 nativeTheme.themeSource，
    // 两个窗口的 CSS 都走 @media (prefers-color-scheme)，所以切换是即时的、不用重启。
    theme: 'system',
  },
});

// 演示模式：命令行/环境变量优先，其次看持久化偏好。
// 持久化这一路是给「双击打开」的用户用的 —— macOS 的 `open --args` 不保证把参数送到
// 应用进程（实测会被丢掉），所以不能只靠 `--demo`。
let DEMO = process.argv.includes('--demo')
  || process.env.BAMBU_BAR_DEMO === '1'
  || !!store.get('demoMode', false);

const locale = () => store.get('locale', 'zh-CN');
const T = (key, params) => t(locale(), key, params);

// ─────────────────────────── 凭据加密 ───────────────────────────
// 令牌与访问码用系统钥匙串（macOS Keychain via safeStorage）加密后落盘；
// 不可用时回退明文并告警（与上游行为一致，保证功能不因环境而失效）。
function encryptSecret(plain) {
  if (plain == null) return null;
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64');
  } catch (e) { console.warn('[secret] 加密不可用:', e && e.message); }
  console.warn('[secret] safeStorage 不可用，凭据以明文存储');
  return String(plain);
}
function decryptSecret(secret) {
  if (secret == null || secret === '') return undefined;
  try {
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(Buffer.from(secret, 'base64'));
  } catch (e) { console.warn('[secret] 解密失败，回退明文:', e && e.message); }
  return String(secret);
}

// ─────────────────────────── 运行时状态 ───────────────────────────
let tray = null;
let popoverWin = null;
let settingsWin = null;
let browserLoginWin = null;
let pendingAuth = null;
let quitting = false;

const runtimes = new Map(); // serial → { lastReport, lastState, stabilizer, timers... }
const errorTables = new Map(); // "<lang>_<model>" → 解析后的官方错误码表
const errorTablePending = new Set();
let lastAuthNotifyAt = 0;
let lastPopoverBlurAt = 0;
let lastSnapshot = null;
let lastSnapshotAt = 0;

function getRuntime(serial) {
  let rt = runtimes.get(serial);
  if (!rt) {
    rt = {
      lastReport: null, lastState: null, lastView: null,
      stabilizer: new StateStabilizer(), stabilizeTimer: null, completionTimer: null,
      lastFilamentColor: null, filamentRefreshAt: null,
      lastSeenAt: null, notified: null,
    };
    runtimes.set(serial, rt);
  }
  return rt;
}

// ─────────────────────────── 统一打印机列表 ───────────────────────────
function getUnified() {
  if (DEMO) return require('./dev/demo-data').demoEntries();
  return registry.mergePrinters(store.get('bambuPrinters', []), store.get('bambuLanPrinters', []));
}

function isHidden(serial) {
  const list = store.get('hiddenPrinters', []) || [];
  return Array.isArray(list) && list.includes(serial);
}
function setHidden(serial, hidden) {
  const list = (store.get('hiddenPrinters', []) || []).filter((s) => s !== serial);
  if (hidden) list.push(serial);
  store.set('hiddenPrinters', list);
}

// ─────────────────────────── 数据源 ───────────────────────────
function makeSourceFor(entry, transport) {
  if (transport === 'lan') {
    const lan = (store.get('bambuLanPrinters', []) || []).find((p) => p.serial === entry.serial);
    if (!lan) return null;
    return new BambuLanDataSource({
      host: lan.host, accessCode: decryptSecret(lan.accessCode), serial: entry.serial,
    });
  }
  const account = store.get('bambuAccount') || {};
  return new BambuCloudDataSource({
    region: account.region, token: decryptSecret(account.token), uid: account.uid, serial: entry.serial,
  });
}

// 官方 HMS 码表（BambuStudio resources/hms/hms_<lang>_<model>.json）：按机型（序列号前 3 位）
// + 语言下载并缓存，失败静默回退。有了它，「打印失败」旁边就能显示官方原因而不是光一个红点。
function errorTableKeyFor(serial) {
  const model = errorCodes.modelCodeFromSerial(serial);
  const lang = errorCodes.langForLocale(locale());
  return model ? `${lang}_${model}` : null;
}

async function ensureErrorTable(serial) {
  const model = errorCodes.modelCodeFromSerial(serial);
  const lang = errorCodes.langForLocale(locale());
  if (!model) return;
  const key = `${lang}_${model}`;
  if (errorTables.has(key) || errorTablePending.has(key)) return;
  errorTablePending.add(key);
  try {
    const fileName = `hms_${lang}_${model}.json`;
    const cachePath = path.join(app.getPath('userData'), 'error-codes', fileName);
    if (fs.existsSync(cachePath)) {
      errorTables.set(key, errorCodes.parseErrorTable(JSON.parse(fs.readFileSync(cachePath, 'utf8')), lang));
      return;
    }
    const res = await netGet('raw.githubusercontent.com', `/bambulab/BambuStudio/master/resources/hms/${fileName}`);
    if (!res || res.statusCode !== 200) return;
    const json = JSON.parse(res.body);
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      fs.writeFileSync(cachePath, res.body);
    } catch { /* 缓存写失败不影响本次使用 */ }
    errorTables.set(key, errorCodes.parseErrorTable(json, lang));
  } catch (e) {
    console.warn('[error-codes] 下载失败:', e && (e.message || e));
  } finally {
    errorTablePending.delete(key);
  }
}

// 走 Electron net 的 GET（尊重系统代理：国内网络下访问 raw.githubusercontent 常需代理）。
function netGet(host, urlPath) {
  const { net } = require('electron');
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', protocol: 'https:', hostname: host, path: urlPath });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { req.abort(); } catch { /* ignore */ }
      reject(new Error('ETIMEDOUT'));
    }, 15000);
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ statusCode: res.statusCode, body });
      });
    });
    req.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    req.end();
  });
}

const hub = new PrinterHub({
  makeSource: makeSourceFor,
  onReport: (serial, report) => applyReport(serial, report),
  onAuthFailure: () => {
    const now = Date.now();
    if (now - lastAuthNotifyAt < 5000) return;
    lastAuthNotifyAt = now;
    notifySettings('printers:changed');
    notifyPopover();
  },
  pickTransport: registry.pickTransport,
});

// 演示模式：把 demo-data 的报文喂进与真机完全相同的 applyReport 链路。
function demoPush() {
  const demo = require('./dev/demo-data');
  for (const serial of demo.serials()) {
    const report = demo.reportFor(serial);
    if (report) applyReport(serial, report);
  }
  render();
}

function startDemo() {
  require('./dev/demo-data').start(demoPush);
  demoPush();
}

function rebuildDataSources() {
  if (DEMO) { render(); return; }
  const unified = getUnified();
  const valid = new Set(unified.map((p) => p.serial));
  for (const [serial, rt] of runtimes) {
    if (!valid.has(serial)) {
      clearTimeout(rt.stabilizeTimer);
      clearTimeout(rt.completionTimer);
      runtimes.delete(serial);
    }
  }
  hub.sync(unified);
  for (const p of unified) ensureErrorTable(p.serial);
  render();
}

// ─────────────────────────── 报文 → 状态 → 视图 ───────────────────────────
function applyReport(serial, report) {
  const rt = getRuntime(serial);
  rt.lastReport = report;
  rt.lastSeenAt = Date.now();
  let state = resolveState(report);
  const rawFilamentColor = state.filamentColor || null;

  // 失败：官方码表把原因归到「大类」（断料/堵头/…），状态文案统一成「打印失败 · 大类」。
  if (state.stateKey === 'failed') {
    const key = errorTableKeyFor(serial);
    const cat = errorCodes.failureCategory(report, key ? errorTables.get(key) || null : null);
    if (cat) state = { ...state, labelKey: `label.failed.${cat}`, labelParams: {} };
  }

  // 完成记忆（同一任务的完成时刻只记一次，跨重启有效）。
  const completion = applyCompletionState(report, state, completionRecord(serial), Date.now());
  saveCompletionRecord(serial, completion.record);
  state = completion.state;
  rt.completionAt = completion.nextUpdateAt;

  // 增量报文的多字段错位会产生一帧级抖动（开印瞬间闪「完成」等），稳定器只作用于对外显示。
  const { state: shown, settleAt } = rt.stabilizer.observe(state, Date.now());
  state = shown;
  scheduleStabilizeTick(serial, settleAt);

  // 耗材色「已知 → 未知」：主动补一次 pushall，把恢复窗口从 5 分钟压到秒级。
  const now = Date.now();
  if (!DEMO && shouldRefreshOnColorLoss({
    prevColor: rt.lastFilamentColor,
    nextColor: rawFilamentColor,
    printActive: isPrintActive(report),
    lastRefreshAt: rt.filamentRefreshAt,
    now,
  })) {
    rt.filamentRefreshAt = now;
    hub.refresh(serial);
  }
  rt.lastFilamentColor = rawFilamentColor;

  rt.lastState = state;
  rt.lastView = buildViewFor(serial);
  notifyTransition(serial, state);
  scheduleRender();
}

function scheduleStabilizeTick(serial, settleAt) {
  const rt = runtimes.get(serial);
  if (!rt) return;
  clearTimeout(rt.stabilizeTimer);
  if (!Number.isFinite(settleAt)) return;
  rt.stabilizeTimer = setTimeout(() => {
    const cur = runtimes.get(serial);
    if (!cur) return;
    const { state, changed, settleAt: next } = cur.stabilizer.tick(Date.now());
    if (changed && state) {
      cur.lastState = state;
      cur.lastView = buildViewFor(serial);
      scheduleRender();
    }
    if (Number.isFinite(next)) scheduleStabilizeTick(serial, next);
  }, Math.max(0, settleAt - Date.now()));
}

function completionRecord(serial) {
  const history = store.get('printCompletionHistory', {}) || {};
  return history[serial] || null;
}
function saveCompletionRecord(serial, record) {
  const history = { ...(store.get('printCompletionHistory', {}) || {}) };
  const prev = history[serial] || null;
  if (JSON.stringify(prev) === JSON.stringify(record)) return;
  if (record) history[serial] = record; else delete history[serial];
  store.set('printCompletionHistory', history);
}

// 状态文案（含完成态的相对时间），在主页一次性算好，渲染层只负责排版。
function statusTextOf(state) {
  if (!state) return T('tray.starting');
  const p = state.labelParams || {};
  if (p.finishedAt != null) {
    const sec = Math.max(0, Math.floor((Date.now() - p.finishedAt) / 1000));
    if (sec < 60) return T('label.finishedJustNow');
    if (sec < 3600) return T('label.finishedMinAgo', { m: Math.floor(sec / 60) });
    return T('label.finishedHourAgo', { h: Math.floor(sec / 3600) });
  }
  return T(state.labelKey, p);
}

function buildViewFor(serial) {
  const entry = getUnified().find((p) => p.serial === serial);
  const rt = runtimes.get(serial);
  if (!entry) return null;
  const key = errorTableKeyFor(serial);
  const table = key ? errorTables.get(key) || null : null;
  const report = rt && rt.lastReport;
  const hmsTexts = {};
  if (table && report && Array.isArray(report.hms)) {
    for (const h of report.hms) {
      if (!h || !Number.isFinite(h.attr) || !Number.isFinite(h.code)) continue;
      const code = (h.attr >>> 0).toString(16).toUpperCase().padStart(8, '0')
        + (h.code >>> 0).toString(16).toUpperCase().padStart(8, '0');
      const intro = table.deviceHms.get(code);
      if (intro) hmsTexts[code] = intro;
    }
  }
  const reasonText = report && table ? errorCodes.lookupFailureReason(report, table) : null;
  const view = buildPrinterView({
    entry,
    report,
    state: rt && rt.lastState,
    now: Date.now(),
    locale: locale(),
    hidden: isHidden(serial),
    reason: {
      text: reasonText,
      category: report ? errorCodes.failureCategory(report, table) : null,
      hmsTexts,
    },
  });
  view.statusText = statusTextOf(rt && rt.lastState);
  view.lastSeenAt = rt ? rt.lastSeenAt : null;
  return view;
}

// 完成 / 失败的系统通知：只在「状态跃迁」时发一次，同一任务不重复打扰。
function notifyTransition(serial, state) {
  if (DEMO || !store.get('notify', true)) return;
  const rt = runtimes.get(serial);
  if (!rt || !state) return;
  const key = state.stateKey;
  if (key !== 'finished' && key !== 'failed') return;
  const entry = getUnified().find((p) => p.serial === serial);
  const name = (entry && entry.name) || serial;
  const task = (rt.lastReport && (rt.lastReport.subtask_name || rt.lastReport.gcode_file)) || '';
  const token = `${key}|${task}|${rt.lastReport && rt.lastReport.task_id}`;
  if (rt.notified === token) return;
  rt.notified = token;
  const body = key === 'finished'
    ? `${task || T('label.finished')}`.trim()
    : statusTextOf(state);
  try {
    const n = new Notification({ title: `${name} · ${T(key === 'finished' ? 'label.finished' : 'label.failed')}`, body, silent: false });
    n.on('click', () => showPopover());
    n.show();
  } catch (e) { console.warn('[notify] 失败:', e && e.message); }
}

// ─────────────────────────── 快照（主 → 渲染） ───────────────────────────
function buildSnapshot() {
  const unified = getUnified();
  const views = [];
  for (const p of unified) {
    if (isHidden(p.serial)) continue;
    const rt = runtimes.get(p.serial);
    const v = rt && rt.lastView ? rt.lastView : buildViewFor(p.serial);
    if (v) {
      // 状态文案按「此刻」重算：完成态的「X 分钟前」不靠报文重发也要走字。
      v.statusText = statusTextOf(rt && rt.lastState);
      views.push(v);
    }
  }
  const account = store.get('bambuAccount') || {};
  const snapshot = {
    mode: DEMO ? 'demo' : 'live',
    locale: locale(),
    account: {
      loggedIn: !!account.token,
      region: account.region || 'global',
      account: account.account || '',
      uid: account.uid || null,
      deviceCount: (store.get('bambuPrinters', []) || []).length,
    },
    summary: summarizeViews(views),
    printers: views,
    prefs: {
      showTrayPercent: store.get('showTrayPercent', true),
      panelWidth: store.get('panelWidth', 400),
      // 面板高度上限由主进程算好下发：渲染层自己拿不到「托盘在哪块屏上」，
      // 而用 vh 会反过来依赖窗口高度，形成「越量越矮」的循环。
      maxPanelHeight: maxPanelHeight(),
    },
    lanCount: (store.get('bambuLanPrinters', []) || []).length,
    updatedAt: Date.now(),
    emptyReason: views.length ? null : (unified.length ? 'hidden' : (account.token ? 'no-printers' : 'not-logged-in')),
  };
  lastSnapshot = snapshot;
  lastSnapshotAt = Date.now();
  return snapshot;
}

const RENDER_MS = 400;
let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => { renderTimer = null; render(); }, RENDER_MS);
}

function render() {
  const snap = buildSnapshot();
  if (popoverWin && !popoverWin.isDestroyed()) popoverWin.webContents.send('state:update', snap);
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send('settings:printersChanged', snap);
  updateTray(snap);
}

function notifyPopover() {
  if (popoverWin && !popoverWin.isDestroyed()) popoverWin.webContents.send('state:update', buildSnapshot());
}
function notifySettings(channel) {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.webContents.send(channel, buildSnapshot());
}

// ─────────────────────────── 托盘 ───────────────────────────
function trayImage() {
  const base = path.join(__dirname, '..', 'assets', 'trayTemplate.png');
  const img = nativeImage.createFromPath(base);
  // 显式补 2x 表示：只靠文件名约定在部分环境下不会被读取，Retina 上会糊。
  try {
    const hi = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate@2x.png'));
    if (!hi.isEmpty()) img.addRepresentation({ scaleFactor: 2, buffer: hi.toPNG() });
  } catch { /* 缺 @2x 时退回 1x */ }
  img.setTemplateImage(true);
  return img;
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayImage());
  tray.setToolTip(T('app.name'));
  tray.on('click', () => togglePopover());
  tray.on('right-click', () => showTrayMenu());
  updateTray(lastSnapshot || buildSnapshot());
}

function updateTray(snap) {
  if (!tray) return;
  const s = (snap && snap.summary) || {};
  const active = (snap && snap.printers || []).filter(
    (v) => v.statusClass === 'printing' || v.statusClass === 'paused' || v.statusClass === 'failed',
  );
  // 菜单栏文字：只有打印中才显示百分比（暂停/失败用图标旁的圆点提示即可，避免长期占宽）。
  let title = '';
  if (store.get('showTrayPercent', true) && s.printing > 0 && Number.isFinite(s.avgPercent)) {
    title = ` ${s.avgPercent}%`;
  } else if (s.failed > 0) {
    title = ' !';
  }
  tray.setTitle(title);
  const parts = [T('app.name')];
  if (s.total) parts.push(`${s.total}`);
  if (s.printing) parts.push(T('pop.summary.printing', { n: s.total, printing: s.printing }));
  else if (active.length) parts.push(statusTextOf(active[0] && runtimes.get(active[0].serial) && runtimes.get(active[0].serial).lastState));
  tray.setToolTip(parts.filter(Boolean).join(' · '));
}

// 右键：原生菜单（菜单栏应用的通行做法；左键仍是完整面板）。
function showTrayMenu() {
  const snap = lastSnapshot || buildSnapshot();
  const items = [];
  for (const v of snap.printers.slice(0, 8)) {
    items.push({ label: `${v.name} · ${v.statusText}`, enabled: false });
  }
  if (!snap.printers.length) items.push({ label: T('pop.summary.none'), enabled: false });
  items.push({ type: 'separator' });
  items.push({ label: T('pop.refresh'), click: () => refreshAll() });
  items.push({ label: T('pop.settings'), click: () => openSettings('account') });
  items.push({ type: 'separator' });
  items.push({
    label: T('menu.demo'),
    type: 'checkbox',
    checked: DEMO,
    click: (mi) => setDemoMode(mi.checked),
  });
  items.push({
    label: T('set.general.launchAtLogin'),
    type: 'checkbox',
    checked: !!app.getLoginItemSettings().openAtLogin,
    click: (mi) => { store.set('launchAtLogin', mi.checked); applyLaunchAtLogin(mi.checked); },
  });
  items.push({ type: 'separator' });
  items.push({ label: T('pop.quit'), click: () => { quitting = true; app.quit(); } });
  const menu = Menu.buildFromTemplate(items);
  if (popoverWin && !popoverWin.isDestroyed() && popoverWin.isVisible()) menu.popup({ window: popoverWin });
  else menu.popup();
}

// 演示模式切换：改的是「数据来源」，运行时换不了（hub 已连上、定时器已起），
// 所以落盘偏好后直接重启自己。菜单栏应用重启不可见，用户只会看到数据变了。
function setDemoMode(on) {
  const next = !!on;
  if (next === DEMO) return;
  store.set('demoMode', next);
  app.relaunch();
  app.exit(0);
}

function applyLaunchAtLogin(enabled) {
  try {
    // 与当前状态一致时不要重复写：沙箱/受管环境下每次写系统登录项都会在系统日志里报错。
    if (app.getLoginItemSettings().openAtLogin === !!enabled) return;
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
  } catch (e) { console.warn('[launch] 设置登录项失败:', e && e.message); }
}

// 外观：把偏好写进 nativeTheme.themeSource。
// 'system' / 'light' / 'dark' 三态，正好是 Electron 原生支持的那三个值。
// 面板与设置窗的样式都写在 @media (prefers-color-scheme: dark) 里，
// 所以改这一处，所有已打开的窗口会立刻换色，不需要重建窗口或重启。
const THEME_VALUES = new Set(['system', 'light', 'dark']);
function applyTheme(source) {
  const v = THEME_VALUES.has(source) ? source : 'system';
  try { nativeTheme.themeSource = v; } catch (e) { console.warn('[theme] 设置失败:', e && e.message); }
  return v;
}

// ─────────────────────────── 弹出面板 ───────────────────────────
// 窗口内不留阴影留白：阴影由系统绘制（见 ensurePopover 的 hasShadow）。
// 留白会让那圈透明区域吃掉点击，且 CSS 模糊一旦大于留白就会被窗口边界硬切。
const MIN_PANEL_H = 120;

function maxPanelHeight() {
  // 上限要按「托盘所在那块屏」的工作区算，不能取主屏 ——
  // 托盘在副屏时，主屏高度算出来的上限会把面板截断或撑出屏幕。
  const anchor = trayAnchor();
  const area = (anchor
    ? screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) })
    : screen.getPrimaryDisplay()).workArea;
  return Math.round(area.height * 0.86);
}

function ensurePopover() {
  if (popoverWin && !popoverWin.isDestroyed()) return popoverWin;
  const width = store.get('panelWidth', 400);
  popoverWin = new BrowserWindow({
    width,
    height: 320,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: true,      // 系统阴影：不受窗口边界裁剪，也不会吃掉边缘点击
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    roundedCorners: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-popover.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  popoverWin.setAlwaysOnTop(true, 'pop-up-menu');
  popoverWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  popoverWin.loadFile(path.join(__dirname, 'popover', 'index.html'));
  popoverWin.webContents.on('did-finish-load', () => {
    popoverWin.webContents.send('state:update', lastSnapshot || buildSnapshot());
  });
  popoverWin.on('blur', () => {
    lastPopoverBlurAt = Date.now();
    if (!DEV && popoverWin && !popoverWin.isDestroyed() && popoverWin.isVisible()) popoverWin.hide();
  });
  popoverWin.on('closed', () => { popoverWin = null; });
  return popoverWin;
}

// 托盘图标在菜单栏里，所以它的矩形一定贴着某块屏的「顶边」。
// 某些环境下 tray.getBounds() 会给出不可用的坐标（实测有返回 y=屏幕底边的情况，
// 多见于无 GUI 会话 / 虚拟显示器），这时按屏幕外处理，避免把面板摆到看不见的地方。
function trayAnchor() {
  if (!tray) return null;
  const b = tray.getBounds();
  if (!b || !b.width || !b.height) return null;
  for (const d of screen.getAllDisplays()) {
    const inX = b.x >= d.bounds.x && b.x <= d.bounds.x + d.bounds.width;
    const inTop = b.y >= d.bounds.y - 2 && b.y <= d.bounds.y + 60;
    if (inX && inTop) return b;
  }
  return null;
}

// 面板挂在托盘图标正下方（宽度不够时贴边）；坐标不可用时退回主屏顶部居中。
function positionPopover() {
  if (!popoverWin || popoverWin.isDestroyed()) return;
  const bounds = popoverWin.getBounds();
  const width = bounds.width;
  const height = bounds.height;
  const anchor = trayAnchor();
  const disp = anchor
    ? screen.getDisplayNearestPoint({ x: Math.round(anchor.x), y: Math.round(anchor.y) })
    : screen.getPrimaryDisplay();
  const wa = disp.workArea;
  let x = anchor ? Math.round(anchor.x + anchor.width / 2 - width / 2) : Math.round(wa.x + (wa.width - width) / 2);
  x = Math.min(Math.max(x, wa.x + 8), wa.x + wa.width - width - 8);
  let y = anchor ? Math.round(anchor.y + anchor.height + 6) : wa.y + 8;
  if (y + height > wa.y + wa.height - 8) {
    y = anchor && anchor.y - height - 6 >= wa.y + 8 ? Math.round(anchor.y - height - 6) : Math.max(wa.y + 8, wa.y + wa.height - height - 8);
  }
  popoverWin.setBounds({ x, y, width, height });
}

function resizePopover(contentHeight) {
  if (!popoverWin || popoverWin.isDestroyed()) return;
  const h = Math.max(MIN_PANEL_H, Math.min(Math.round(contentHeight), maxPanelHeight()));
  const b = popoverWin.getBounds();
  if (b.height === h) return;
  popoverWin.setBounds({ x: b.x, y: b.y, width: b.width, height: h });
  // 透明窗口改尺寸后系统阴影会沿用上一帧的轮廓（表现为边缘留一圈旧阴影），必须作废重算。
  if (typeof popoverWin.invalidateShadow === 'function') popoverWin.invalidateShadow();
  positionPopover();
}

function showPopover() {
  ensurePopover();
  if (lastSnapshot) popoverWin.webContents.send('state:update', lastSnapshot);
  // 面板打开时若数据已陈旧，顺手戳一次 pushall —— 用户看到的是「此刻」而不是几分钟前的快照。
  if (!DEMO && Date.now() - lastSnapshotAt > 15000) refreshAll(false);
  positionPopover();
  popoverWin.show();
  popoverWin.focus();
}

function togglePopover() {
  if (Date.now() - lastPopoverBlurAt < 250) return; // 点击托盘时窗口先 blur，避免「关掉又立刻打开」
  if (popoverWin && !popoverWin.isDestroyed() && popoverWin.isVisible()) {
    popoverWin.hide();
  } else {
    showPopover();
  }
}

function hidePopover() {
  if (popoverWin && !popoverWin.isDestroyed()) popoverWin.hide();
}

// 立刻刷新：向每台已连接的打印机请求一次完整状态（pushall），并同步云端在线状态。
async function refreshAll(alsoCloud = true) {
  if (DEMO) { require('./dev/demo-data').tick(); demoPush(); return; }
  for (const serial of hub.serials()) hub.refresh(serial);
  if (alsoCloud) await refreshCloudPrinters();
  render();
}

// ─────────────────────────── 云端轮询 ───────────────────────────
let cloudPollTimer = null;

async function refreshCloudPrinters() {
  if (DEMO) return;
  const account = store.get('bambuAccount');
  if (!account || !account.token) return;
  const r = await bambuAuth.listDevices(account.region, decryptSecret(account.token));
  let roseSerials = [];
  if (r.ok) {
    const prevList = store.get('bambuPrinters', []) || [];
    const prevBySerial = new Map(prevList.map((p) => [p.serial, p]));
    // 「重新上线」的上升沿：主动 pushall，免等 5 分钟定时（真机重启/早上开机场景）。
    roseSerials = registry.onlineRoseSerials(prevList, r.devices);
    store.set('bambuPrinters', r.devices.map((d) => ({
      serial: d.serial,
      name: (prevBySerial.get(d.serial) && prevBySerial.get(d.serial).name) || d.name,
      model: d.model,
      online: d.online,
      printStatus: d.printStatus || null,
    })));
  } else {
    const printers = store.get('bambuPrinters', []) || [];
    store.set('bambuPrinters', printers.map((p) => ({ ...p, online: null, printStatus: null })));
  }
  rebuildDataSources();
  for (const serial of roseSerials) hub.refresh(serial);
  notifySettings('printers:changed');
}

function startCloudPoll() {
  if (cloudPollTimer) clearInterval(cloudPollTimer);
  const ms = Math.max(20000, Number(store.get('pollMs', 45000)) || 45000);
  cloudPollTimer = setInterval(refreshCloudPrinters, ms);
}

// ─────────────────────────── 设置窗 ───────────────────────────
function openSettings(section = 'account') {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    settingsWin.webContents.send('settings:navigate', section);
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 600,
    minWidth: 640,
    minHeight: 480,
    title: T('set.title'),
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload-settings.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  settingsWin.loadFile(path.join(__dirname, 'settings', 'index.html'), { hash: section });
  settingsWin.once('ready-to-show', () => settingsWin.show());
  settingsWin.webContents.on('did-finish-load', () => {
    settingsWin.webContents.send('settings:navigate', section);
  });
  settingsWin.on('closed', () => { settingsWin = null; });
}

// ─────────────────────────── 登录 ───────────────────────────
function localizeMsg(msg, params) {
  const loc = locale();
  const map = STRINGS[loc] || STRINGS['zh-CN'];
  return msg != null && map[msg] != null ? t(loc, msg, params || {}) : msg;
}
function localizeResult(r) {
  return r && r.error ? { ...r, error: localizeMsg(r.error, r.errorParams) } : r;
}
function resolveActiveToken() {
  if (pendingAuth && pendingAuth.token) return pendingAuth;
  const account = store.get('bambuAccount') || {};
  return { region: account.region || 'global', token: decryptSecret(account.token), uid: account.uid };
}

const BROWSER_LOGIN_PARTITION = 'persist:bambu-web-login';

// 浏览器登录：弹官方页面，只监听会话 cookie 里的 token（绝不注入 JS、不读表单）。
async function openBrowserLogin(region) {
  if (browserLoginWin && !browserLoginWin.isDestroyed()) {
    browserLoginWin.focus();
    return { ok: false, error: browserLogin.ERR_BUSY };
  }
  const url = browserLogin.LOGIN_URLS[region];
  if (!url) return { ok: false, error: browserLogin.ERR_UNSUPPORTED_REGION };
  const ses = session.fromPartition(BROWSER_LOGIN_PARTITION);
  ses.setUserAgent(browserLogin.sanitizeUserAgent(ses.getUserAgent(), app.getName()));

  const validate = async (token) => {
    const u = await bambuAuth.getUid(region, token);
    return u.ok ? { ok: true, token, uid: u.uid, account: u.handle || '' } : null;
  };

  const existing = browserLogin.pickTokenCookie(await ses.cookies.get({}));
  if (existing) {
    const r = await validate(existing.value);
    if (r) return r;
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      try { ses.cookies.off('changed', onCookieChanged); } catch { /* 已移除 */ }
      const w = browserLoginWin;
      browserLoginWin = null;
      if (w && !w.isDestroyed()) { w.removeAllListeners('closed'); w.close(); }
      resolve(r);
    };
    let checking = false;
    const tryToken = async (value) => {
      if (checking || settled) return;
      checking = true;
      try {
        const r = await validate(value);
        if (r) finish(r);
      } finally { checking = false; }
    };
    const onCookieChanged = (_e, cookie, _c, removed) => {
      if (!removed && browserLogin.isTokenCookie(cookie)) tryToken(cookie.value);
    };
    ses.cookies.on('changed', onCookieChanged);

    browserLoginWin = new BrowserWindow({
      width: 1024,
      height: 760,
      title: 'Bambu Lab',
      autoHideMenuBar: true,
      webPreferences: {
        partition: BROWSER_LOGIN_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    });
    browserLoginWin.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: { partition: BROWSER_LOGIN_PARTITION, nodeIntegration: false, contextIsolation: true, sandbox: true },
      },
    }));
    browserLoginWin.webContents.on('did-navigate', async () => {
      const c = browserLogin.pickTokenCookie(await ses.cookies.get({}));
      if (c) tryToken(c.value);
    });
    browserLoginWin.on('closed', () => finish({ ok: false, canceled: true }));
    browserLoginWin.loadURL(url);
  });
}

// 登录成功后：持久化账号 + 拉全部云端设备（「所有绑定的打印机」一次全进来）。
async function completeCloudLogin() {
  const { region, token, uid } = resolveActiveToken();
  if (!token) return { ok: false, error: T('settings.errAuthExpired') };
  const existing = store.get('bambuAccount', {}) || {};
  store.set('bambuAccount', {
    region,
    account: (pendingAuth && pendingAuth.account) || existing.account || '',
    uid,
    token: encryptSecret(token),
  });
  const r = await bambuAuth.listDevices(region, token);
  if (r.ok) {
    const prevBySerial = new Map((store.get('bambuPrinters', []) || []).map((p) => [p.serial, p]));
    store.set('bambuPrinters', r.devices.map((d) => ({
      serial: d.serial,
      name: (prevBySerial.get(d.serial) && prevBySerial.get(d.serial).name) || d.name,
      model: d.model,
      online: d.online,
      printStatus: d.printStatus || null,
    })));
  }
  store.set('dataSource', 'live');
  pendingAuth = null;
  rebuildDataSources();
  startCloudPoll();
  return { ok: true, deviceCount: (store.get('bambuPrinters', []) || []).length, error: r.ok ? null : localizeMsg(r.error) };
}

// 局域网探活：6 秒内收到报文即成功；超时按 classifyLanProbe 区分为访问码错 / 序列号错 / 网络不通。
async function testLanConnection(host, accessCode, serial) {
  const ERR_KEY = {
    serial: 'settings.errLanSerial', auth: 'settings.errLanAuth',
    network: 'settings.errLanNetwork', timeout: 'settings.errLanTimeout',
  };
  return new Promise((resolve) => {
    const probe = new BambuLanDataSource({ host, accessCode, serial });
    let done = false;
    let gotConnect = false;
    let lastError = null;
    let timer = null;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      probe.stop();
      resolve(r);
    };
    probe.onDiagnostic((evt) => {
      if (evt.type === 'connect') gotConnect = true;
      else if (evt.type === 'error') lastError = evt.error;
    });
    probe.onState((report) => { if (report.connected) finish({ ok: true }); });
    probe.start();
    timer = setTimeout(() => {
      const reason = classifyLanProbe({ gotConnect, error: lastError });
      finish({ ok: false, error: T(ERR_KEY[reason]) });
    }, 6000);
  });
}

// ─────────────────────────── 打印机增删改 ───────────────────────────
function renamePrinter(serial, name) {
  const clean = String(name || '').trim();
  if (!clean) return false;
  const cloud = store.get('bambuPrinters', []) || [];
  if (cloud.some((p) => p.serial === serial)) {
    store.set('bambuPrinters', cloud.map((p) => (p.serial === serial ? { ...p, name: clean } : p)));
  }
  const lan = store.get('bambuLanPrinters', []) || [];
  if (lan.some((p) => p.serial === serial)) {
    store.set('bambuLanPrinters', lan.map((p) => (p.serial === serial ? { ...p, name: clean } : p)));
  }
  rebuildDataSources();
  return true;
}

function removeLanPrinter(serial) {
  const lan = (store.get('bambuLanPrinters', []) || []).filter((p) => p.serial !== serial);
  store.set('bambuLanPrinters', lan);
  const hidden = (store.get('hiddenPrinters', []) || []).filter((s) => s !== serial);
  store.set('hiddenPrinters', hidden);
  rebuildDataSources();
  return true;
}

// ─────────────────────────── 诊断信息 ───────────────────────────
function collectDiagnostics() {
  const snap = lastSnapshot || buildSnapshot();
  const lines = [
    `${T('app.name')} ${app.getVersion()} · Electron ${process.versions.electron} · ${process.platform} ${process.arch} · macOS ${require('os').release()}`,
    `locale=${locale()} mode=${snap.mode} poll=${store.get('pollMs', 45000)}ms`,
    `account: loggedIn=${snap.account.loggedIn} region=${snap.account.region} cloudDevices=${snap.account.deviceCount} lanDevices=${snap.lanCount}`,
    `summary: total=${snap.summary.total} printing=${snap.summary.printing} paused=${snap.summary.paused} failed=${snap.summary.failed} offline=${snap.summary.offline}`,
    'printers:',
  ];
  for (const v of snap.printers) {
    lines.push(`  · ${v.name} [${v.model || '?'}/${v.serial}] source=${v.source} state=${v.stateKey || '-'} `
      + `gcode=${v.gcodeState || '-'} pct=${v.progress.percent} layer=${v.progress.layer}/${v.progress.total} `
      + `nozzle=${v.temps.nozzleTemp}/${v.temps.targetNozzleTemp} bed=${v.temps.bedTemp}/${v.temps.targetBedTemp} `
      + `chamber=${v.temps.chamberTemp} remain=${v.progress.remainText || '-'} `
      + `hms=${(v.hms || []).map((h) => h.code).join(',') || '-'} fail=${v.failReason || '-'}`);
    // BAMBU_BAR_DUMP_RAW=1：把报文里与温度/腔温相关的原始字段一并打出来。
    // 机型之间「有没有腔温」只能靠原始字段判断 —— 光看解析结果是看不出来的
    // （无腔温的机型也可能带着 chamber_temper 这个键，只是值没有意义）。
    if (process.env.BAMBU_BAR_DUMP_RAW) {
      const rt = runtimes.get(v.serial);
      lines.push(`      raw.temps=${JSON.stringify(pickTempFields(rt && rt.lastReport))}`);
    }
  }
  return lines.join('\n');
}

/** 递归挑出报文里与温度/腔温相关的字段（只用于诊断输出，不做解析）。 */
function pickTempFields(obj, prefix = '', out = {}, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 3) return out;
  for (const [k, val] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (/temp|ctc|chamber/i.test(k)) out[p] = val;
    else if (val && typeof val === 'object' && !Array.isArray(val)) pickTempFields(val, p, out, depth + 1);
  }
  return out;
}

// ─────────────────────────── IPC ───────────────────────────
ipcMain.handle('state:snapshot', () => lastSnapshot || buildSnapshot());
ipcMain.handle('ui:strings', () => bundle(locale()));
ipcMain.handle('ui:height', (_e, h) => { resizePopover(h); return true; });
ipcMain.handle('ui:ready', (e) => { e.sender.send('state:update', lastSnapshot || buildSnapshot()); });
ipcMain.on('popover:hide', () => hidePopover());

ipcMain.handle('app:refreshAll', async () => { await refreshAll(true); return true; });
ipcMain.handle('app:refreshOne', (_e, serial) => {
  if (DEMO) { demoPush(); return true; }
  hub.refresh(serial);
  return true;
});
ipcMain.handle('app:copy', (_e, text) => { clipboard.writeText(String(text || '')); return true; });
ipcMain.handle('app:openSettings', (_e, section) => { hidePopover(); openSettings(section || 'account'); return true; });
ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('app:diagnostics', () => collectDiagnostics());
ipcMain.handle('app:revealData', () => { shell.openPath(app.getPath('userData')); return true; });

ipcMain.handle('printer:hide', (_e, serial, hidden) => { setHidden(serial, !!hidden); render(); return true; });
ipcMain.handle('printer:rename', (_e, serial, name) => renamePrinter(serial, name));
ipcMain.handle('printer:remove', (_e, serial) => removeLanPrinter(serial));

ipcMain.handle('settings:state', () => {
  const acc = store.get('bambuAccount') || null;
  return {
    locale: locale(),
    // 只回传展示所需字段，令牌（即使已加密）不出主进程
    account: acc ? { region: acc.region, account: acc.account, uid: acc.uid, loggedIn: !!acc.token } : null,
    prefs: {
      showTrayPercent: store.get('showTrayPercent', true),
      launchAtLogin: !!app.getLoginItemSettings().openAtLogin,
      notify: store.get('notify', true),
      pollMs: store.get('pollMs', 45000),
      theme: store.get('theme', 'system'),
    },
    cloudPrinters: (store.get('bambuPrinters', []) || []).map((p) => ({ ...p, hidden: isHidden(p.serial) })),
    lanPrinters: (store.get('bambuLanPrinters', []) || []).map((p) => ({
      serial: p.serial, name: p.name, model: p.model, host: p.host, hidden: isHidden(p.serial),
    })),
    version: app.getVersion(),
  };
});

ipcMain.handle('settings:setPref', (_e, key, value) => {
  if (['showTrayPercent', 'notify', 'launchAtLogin', 'pollMs', 'theme'].includes(key)) {
    store.set(key, value);
    if (key === 'launchAtLogin') applyLaunchAtLogin(value);
    if (key === 'pollMs') startCloudPoll();
    if (key === 'theme') applyTheme(value);
    updateTray(lastSnapshot || buildSnapshot());
    return true;
  }
  if (key === 'locale') {
    store.set('locale', value);
    if (tray) tray.setToolTip(T('app.name'));
    if (settingsWin && !settingsWin.isDestroyed()) settingsWin.setTitle(T('set.title'));
    if (popoverWin && !popoverWin.isDestroyed()) popoverWin.webContents.send('ui:locale', bundle(locale()));
    render();
    return true;
  }
  return false;
});

ipcMain.handle('bambu:browserLogin', async (_e, region) => {
  const r = await openBrowserLogin(region || 'global');
  if (r.ok) pendingAuth = { region: region || 'global', account: r.account || '', token: r.token, uid: r.uid };
  return localizeResult(r);
});
ipcMain.handle('bambu:login', async (_e, region, account, password) => {
  const r = await bambuAuth.login(region, account, password);
  if (r.ok) pendingAuth = { region, account, token: r.token, uid: r.uid };
  return localizeResult(r);
});
ipcMain.handle('bambu:verify', async (_e, region, account, password, tfaKey, code) => {
  const r = await bambuAuth.sendVerifyCode(region, account, password, tfaKey, code);
  if (r.ok) pendingAuth = { region, account, token: r.token, uid: r.uid };
  return localizeResult(r);
});
ipcMain.handle('bambu:requestSmsCode', async (_e, region, phone) =>
  localizeResult(await bambuAuth.requestSmsCode(region, phone)));
ipcMain.handle('bambu:loginWithCode', async (_e, region, account, code, tfaKey) => {
  const r = await bambuAuth.loginWithCode(region, account, code, tfaKey);
  if (r.ok) pendingAuth = { region, account, token: r.token, uid: r.uid };
  return localizeResult(r);
});
ipcMain.handle('bambu:completeCloudLogin', () => completeCloudLogin());
ipcMain.handle('bambu:logout', async () => {
  store.set('bambuAccount', null);
  pendingAuth = null;
  hub.stopAll();
  runtimes.clear();
  try {
    const ses = session.fromPartition(BROWSER_LOGIN_PARTITION);
    await ses.clearStorageData();
  } catch (e) { console.warn('[logout] 清理网页会话失败:', e && e.message); }
  rebuildDataSources();
  return { ok: true };
});

ipcMain.handle('lan:add', async (_e, { host, accessCode, serial, name }) => {
  if (!host || !accessCode || !serial) return { ok: false, error: T('settings.errLanFields') };
  const probe = await testLanConnection(String(host).trim(), String(accessCode).trim(), String(serial).trim());
  if (!probe.ok) return probe;
  const list = (store.get('bambuLanPrinters', []) || []).filter((p) => p.serial !== serial);
  list.push({
    serial: String(serial).trim(),
    name: (name && String(name).trim()) || String(serial).trim(),
    model: '',
    host: String(host).trim(),
    accessCode: encryptSecret(String(accessCode).trim()),
  });
  store.set('bambuLanPrinters', list);
  store.set('dataSource', 'live');
  rebuildDataSources();
  return { ok: true };
});
ipcMain.handle('lan:remove', (_e, serial) => removeLanPrinter(serial));

ipcMain.handle('window:closeSettings', () => {
  if (settingsWin && !settingsWin.isDestroyed()) settingsWin.close();
});

// ─────────────────────────── 生命周期 ───────────────────────────
// 菜单栏应用没有窗口可看：启动阶段一旦抛异常，用户看到的就是「双击了但什么都没发生」。
// 所以整段启动逻辑包一层，把错误落到 userData/startup-error.log 并弹一条系统通知。
function reportStartupError(stage, err) {
  const text = [
    `[${new Date().toISOString()}] ${stage}`,
    (err && err.stack) || String(err),
    '',
  ].join('\n');
  try {
    const file = path.join(app.getPath('userData'), 'startup-error.log');
    fs.appendFileSync(file, text);
    console.error(`[startup] ${stage}:`, (err && err.message) || err, `\n  → ${file}`);
  } catch (e) {
    console.error('[startup] 无法写入错误日志:', e && e.message);
  }
  try {
    if (Notification.isSupported()) {
      new Notification({
        title: 'Bambu Bar 启动失败',
        body: `${stage}: ${(err && err.message) || err}`,
      }).show();
    }
  } catch { /* 通知不可用就算了，日志已经落盘 */ }
}

app.whenReady().then(() => {
  try {
    boot();
  } catch (err) {
    reportStartupError('whenReady', err);
  }
});

function boot() {
  console.log('[boot] enter');
  if (app.dock) app.dock.hide(); // 纯菜单栏应用：不占程序坞
  applyLaunchAtLogin(store.get('launchAtLogin', false));
  console.log('[boot] loginItem ok');
  // 外观必须在建任何窗口之前应用，否则第一帧会闪一下系统配色。
  console.log('[boot] theme =', applyTheme(store.get('theme', 'system')));
  createTray();
  console.log('[boot] tray =', tray ? JSON.stringify(tray.getBounds()) : 'none');
  // 显示器/分辨率变化后重新贴靠托盘（否则面板会飘到屏幕外）。必须在 ready 之后注册。
  screen.on('display-metrics-changed', () => { if (popoverWin && popoverWin.isVisible()) positionPopover(); });
  if (DEMO) {
    startDemo();
    console.log('[boot] demo started');
  } else {
    try {
      rebuildDataSources();
      console.log('[boot] sources rebuilt');
      startCloudPoll();
      console.log('[boot] poll started');
      // 启动后拉一次云端设备（首次登录的用户无需等待 45 秒轮询）
      setTimeout(() => { refreshCloudPrinters().catch((e) => console.warn('[cloud] 首次刷新失败:', e && e.message)); }, 1200);
    } catch (err) {
      // 连不上打印机不该让整个应用起不来：托盘和面板仍然可用。
      reportStartupError('connect', err);
    }
  }
  if (DEV) showPopover();
  // 诊断用：把当前快照 dump 到 stdout 后退出（无头环境验证整条链路，也便于排障）。
  // BAMBU_BAR_DUMP_WAIT=<ms> 可加长等待：云端连接 + 首帧报文常常要好几秒，2.5s 不够。
  if (process.env.BAMBU_BAR_DUMP) {
    const waitMs = Number(process.env.BAMBU_BAR_DUMP_WAIT) || 2500;
    setTimeout(() => { console.log(collectDiagnostics()); app.exit(0); }, waitMs);
  }
  // 诊断用：打印托盘的真实位置与标题（排查「图标在但文字不显示」这类问题）。
  // 设为 hold 时只打印不退出，便于同一次运行里再做截图比对。
  if (process.env.BAMBU_BAR_TRAY_DEBUG) {
    const hold = process.env.BAMBU_BAR_TRAY_DEBUG === 'hold';
    setTimeout(() => {
      const snap = lastSnapshot || buildSnapshot();
      console.log('tray.bounds =', JSON.stringify(tray && tray.getBounds()));
      console.log('tray.title  =', JSON.stringify(tray && tray.getTitle()));
      console.log('tray.anchor =', JSON.stringify(trayAnchor()));
      console.log('popover     =', JSON.stringify(popoverWin && !popoverWin.isDestroyed()
        ? { visible: popoverWin.isVisible(), bounds: popoverWin.getBounds() }
        : null));
      console.log('summary     =', JSON.stringify(snap.summary));
      console.log('pref.showTrayPercent =', JSON.stringify(store.get('showTrayPercent', true)));
      if (!hold) app.exit(0);
    }, 3500);
  }
}

// 菜单栏应用：关掉所有窗口也不退进程（没有窗口正是常态）。
app.on('window-all-closed', () => {});

app.on('before-quit', () => { quitting = true; if (hub) hub.stopAll(); });

app.on('second-instance', () => showPopover());



module.exports = { buildSnapshot, collectDiagnostics };
