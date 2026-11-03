// 官方 HMS / 错误码表这一层的单测：报文 → 失败中文说明。
//
// 这条链路横跨两个地方，回归起来最容易悄悄坏掉：
//   Rust 侧负责把表弄到手（src-tauri/src/error_codes.rs）
//   JS 侧负责解析与查表（src/core/bambu-error-codes.js，Electron 版原样保留）
// 这里测的是后者，以及它和 buildPrinterView 的接缝。
const test = require('node:test');
const assert = require('node:assert');

const errorCodes = require('../src/core/bambu-error-codes');
const { buildPrinterView } = require('../src/core/printer-view');

// 取自 BambuStudio resources/hms/hms_zh-cn_01P.json 的结构（节选）。
// device_error 是 8 位 hex 的失败原因码，device_hms 是 16 位 hex 的告警码。
const TABLE_JSON = {
  data: {
    device_error: {
      ver: 202609231145,
      'zh-cn': [
        { ecode: '0300400C', intro: '任务已取消。' },
        { ecode: '07004001', intro: '检测到禁用AMS时仍从AMS加载料。' },
      ],
    },
    device_hms: {
      ver: 202609231145,
      'zh-cn': [
        { ecode: '0300E50000020001', intro: '检测到多次运动丢步。' },
        // 空 intro：官方表里确实有这类占位条目，查得到但没有文案可显示
        { ecode: '0700800000000000', intro: '' },
      ],
    },
  },
};

const table = errorCodes.parseErrorTable(TABLE_JSON, 'zh-cn');
const entry = {
  serial: '01P00C560200187', name: 'Bambu P1S', model: 'P1S',
  source: 'cloud', hasCloud: true, hasLan: false, host: null, online: true,
};

// 0x0300400C → "任务已取消。"
const cancelledReport = {
  connected: true,
  gcode_state: 'FAILED',
  fail_reason: 0x0300400C,
  mc_percent: 30,
};

const hmsReport = {
  connected: true,
  gcode_state: 'FAILED',
  fail_reason: 0,
  hms: [
    { attr: 0x0300E500, code: 0x00020001 },
    { attr: 0x07008000, code: 0x00000000 },
  ],
};

test('码表解析出两张子表，ecode 统一大写', () => {
  assert.equal(table.deviceError.size, 2);
  assert.equal(table.deviceHms.size, 2);
  assert.ok(table.deviceError.has('0300400C'));
  assert.equal(table.ver, 202609231145);
});

test('机型代号取序列号前 3 位', () => {
  assert.equal(errorCodes.modelCodeFromSerial('01P00C560200187'), '01P');
  assert.equal(errorCodes.modelCodeFromSerial('03919B610800044'), '039');
  assert.equal(errorCodes.modelCodeFromSerial(''), null);
});

test('语言按 locale 走：中文简体，其余英文', () => {
  assert.equal(errorCodes.langForLocale('zh-CN'), 'zh-cn');
  assert.equal(errorCodes.langForLocale('en-US'), 'en');
});

test('fail_reason 查到官方失败原因文案', () => {
  const reason = errorCodes.lookupFailureReason(cancelledReport, table);
  assert.equal(reason, '任务已取消。');
});

test('查不到就返回 null，交给调用方回退通用文案', () => {
  assert.equal(errorCodes.lookupFailureReason({ fail_reason: 0xDEADBEEF }, table), null);
  assert.equal(errorCodes.lookupFailureReason(null, table), null);
});

test('没有码表时不猜文案', () => {
  assert.equal(errorCodes.lookupFailureReason(cancelledReport, null), null);
  assert.equal(errorCodes.failureCategory(cancelledReport, null), null);
});

test('失败大类按官方文案归类', () => {
  // "任务已取消" 不属于任何特定大类 → null
  assert.equal(errorCodes.failureCategory(cancelledReport, table), null);

  // 断料类文案 → runout
  const runoutTable = errorCodes.parseErrorTable({
    data: { device_error: { 'zh-cn': [{ ecode: '0300400C', intro: '耗材用尽，请装入新耗材。' }] } },
  }, 'zh-cn');
  assert.equal(errorCodes.failureCategory(cancelledReport, runoutTable), 'runout');
});

test('hms 码按 attr+code 拼 16 位 hex 查文案', () => {
  // 0x0300E50000020001 有文案；0x0700800000000000 是空串，不算「有文案」
  const intro = table.deviceHms.get('0300E50000020001');
  assert.equal(intro, '检测到多次运动丢步。');
  assert.equal(table.deviceHms.get('0700800000000000'), '');
});

test('视图把失败原因与 HMS 文案带给面板', () => {
  const hmsTexts = {};
  for (const h of hmsReport.hms) {
    const code = (h.attr >>> 0).toString(16).toUpperCase().padStart(8, '0')
      + (h.code >>> 0).toString(16).toUpperCase().padStart(8, '0');
    const intro = table.deviceHms.get(code);
    if (intro) hmsTexts[code] = intro;
  }

  const view = buildPrinterView({
    entry,
    report: hmsReport,
    state: { stateKey: 'failed', labelKey: 'label.failed', labelParams: {} },
    reason: { text: null, category: null, hmsTexts },
  });

  assert.equal(view.statusClass, 'failed');
  assert.equal(view.error.text, null);
  assert.equal(view.error.hmsTexts['0300E50000020001'], '检测到多次运动丢步。');
  // 面板上悬停 HMS 码用的就是 h.code（16 位 hex），key 必须对得上
  assert.equal(view.hms[0].code, '0300E50000020001');
  assert.ok(view.error.hmsTexts[view.hms[0].code]);
});

test('没有码表时视图的 error 字段是空的，但不崩', () => {
  const view = buildPrinterView({
    entry,
    report: cancelledReport,
    state: { stateKey: 'failed', labelKey: 'label.failed', labelParams: {} },
    reason: { text: null, category: null, hmsTexts: {} },
  });
  assert.equal(view.error.text, null);
  assert.equal(view.error.category, null);
  assert.deepEqual(view.error.hmsTexts, {});
  assert.equal(view.failReason, 0x0300400C);
});
