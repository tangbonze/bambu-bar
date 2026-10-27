// printer-view / 注册表的纯逻辑单测：报文 → 面板视图这一层不能靠肉眼验证。
const test = require('node:test');
const assert = require('node:assert');

const {
  buildPrinterView, summarizeViews, extractFilament, parseColor, formatEta,
} = require('../src/core/printer-view');
const registry = require('../src/core/printer-registry');
const { resolveState } = require('../src/core/state-machine');

const entry = {
  serial: '00M09A350100001', name: 'X1C', model: 'X1C',
  source: 'cloud', hasCloud: true, hasLan: false, host: null, online: true,
};

const printingReport = {
  connected: true,
  gcode_state: 'RUNNING',
  stg_cur: 0,
  mc_percent: 42,
  mc_remaining_time: 83,
  layer_num: 118,
  total_layer_num: 280,
  nozzle_temper: 219.6,
  nozzle_target_temper: 220,
  bed_temper: 60.2,
  bed_target_temper: 60,
  chamber_temper: 34.4,
  spd_lvl: 3,
  spd_mag: 124,
  wifi_signal: -52,
  subtask_name: 'benchy.3mf',
  ams: {
    tray_now: '0',
    ams: [{
      id: '0',
      humidity: '1',
      temp: '24.2',
      tray: [
        { id: '0', tray_color: 'F2F2F0FF', tray_type: 'PLA', remain: 72 },
        { id: '1', tray_color: '00000000', tray_type: '', remain: -1 },
      ],
    }],
  },
  vt_tray: { id: '254', tray_color: 'D93A2BFF', tray_type: 'PETG', remain: -1 },
  hms: [{ attr: 0x0C000100, code: 0x00010002 }],
  fail_reason: 0,
};

test('parseColor：alpha=00 是「无颜色」而不是黑色', () => {
  assert.equal(parseColor('00000000'), null);
  assert.equal(parseColor('000000FF'), '#000000');
  assert.equal(parseColor('F2F2F0FF'), '#f2f2f0');
  assert.equal(parseColor('zzzzzz'), null);
  assert.equal(parseColor(null), null);
});

test('extractFilament：tray_now 指向的槽被标为 active，外挂料盘单列', () => {
  const f = extractFilament(printingReport);
  assert.equal(f.units.length, 1);
  assert.equal(f.units[0].slots.length, 2);
  assert.equal(f.units[0].slots[0].active, true);
  assert.equal(f.units[0].slots[1].active, false);
  assert.equal(f.units[0].slots[1].color, null, 'alpha=00 的空槽不该被当成黑色');
  assert.equal(f.units[0].humidityText, 'dryish');
  assert.equal(f.external.color, '#d93a2b');
  assert.equal(f.external.active, false);
  assert.equal(f.count, 3);
});

test('extractFilament：tray_now=254 时外挂料盘为当前耗材', () => {
  const r = { ...printingReport, ams: { ...printingReport.ams, tray_now: '254' } };
  const f = extractFilament(r);
  assert.equal(f.external.active, true);
  assert.equal(f.units[0].slots[0].active, false);
});

test('extractFilament：tray_now=255（无耗材）时不把任何槽标成 active', () => {
  const r = { ...printingReport, ams: { ...printingReport.ams, tray_now: '255' } };
  const f = extractFilament(r);
  assert.equal(f.units[0].slots[0].active, false);
  assert.equal(f.activeKey, null);
});

test('extractFilament：外挂料盘不计入 amsSlotCount（有外挂 ≠ 有 AMS）', () => {
  const f = extractFilament(printingReport);
  assert.equal(f.amsSlotCount, 2, '两个 AMS 槽');
  assert.equal(f.count, 3, 'count 仍含外挂料盘');
  assert.ok(f.external, '外挂料盘单列');
});

test('buildPrinterView：无 AMS 的机器 hasAms=false、hasExternal=true', () => {
  // A1 mini 这类只挂外挂料盘的机器：ams.ams 是空数组，料在 vt_tray 里。
  const report = {
    ...printingReport,
    ams: { tray_now: '254', ams: [] },
    vt_tray: { id: '254', tray_color: 'F7D64AFF', tray_type: 'PLA', remain: 84 },
  };
  const v = buildPrinterView({ entry, report, state: resolveState(report), locale: 'zh-CN' });
  assert.equal(v.filament.hasAms, false, '面板据此把 AMS 标签置灰');
  assert.equal(v.filament.hasExternal, true, '外置标签据此类亮起');
  assert.equal(v.filament.units.length, 0);
  assert.equal(v.filament.current, '#f7d64a');
});

test('buildPrinterView：有 AMS 但没接外挂料盘时 hasExternal=false', () => {
  const report = { ...printingReport, vt_tray: undefined };
  const v = buildPrinterView({ entry, report, state: resolveState(report), locale: 'zh-CN' });
  assert.equal(v.filament.hasAms, true);
  assert.equal(v.filament.hasExternal, false);
});

test('formatEta：按本机时区算出完成时刻，并给出跨天天数', () => {
  const now = new Date(2026, 9, 26, 23, 0, 0).getTime();
  const eta = formatEta(120, now, 'zh-CN'); // 23:00 + 2h → 次日 01:00
  assert.equal(eta.text, '01:00');
  assert.equal(eta.offset, 1);
  assert.equal(eta.dayOffset, '+1');
});

test('buildPrinterView：打印中 → 进度/层数/温度/耗材/速度全部到位', () => {
  const state = resolveState(printingReport);
  const v = buildPrinterView({ entry, report: printingReport, state, now: Date.now(), locale: 'zh-CN' });

  assert.equal(v.statusClass, 'printing');
  assert.equal(v.progress.percent, 42);
  assert.equal(v.progress.layer, 118);
  assert.equal(v.progress.remainText, '1h23m');
  assert.ok(v.progress.etaText, '应算出预计完成时刻');
  assert.equal(v.temps.nozzleTemp, 220);
  assert.equal(v.temps.bedTemp, 60);
  // X1C 没有腔温控制器：报文里那个 chamber_temper 是占位值，不该当成温度显示。
  assert.equal(v.temps.chamberTemp, null);
  assert.equal(v.filament.current, '#f2f2f0');
  assert.equal(v.speed.level, 'sport');
  assert.equal(v.speed.mag, 124);
  assert.equal(v.job, 'benchy.3mf');
  assert.equal(v.hms.length, 1);
  assert.equal(v.wifi, -52);
});

test('buildPrinterView：新固件 device.* 打包温度（低16位当前 / 高16位目标）', () => {
  const report = {
    connected: true,
    gcode_state: 'IDLE',
    device: {
      extruder: { info: [{ id: 0, temp: (200 << 16) | 28 }] },
      bed: { info: { temp: (60 << 16) | 31 } },
    },
  };
  const v = buildPrinterView({ entry, report, state: resolveState(report), now: Date.now() });
  assert.equal(v.temps.nozzleTemp, 28);
  assert.equal(v.temps.targetNozzleTemp, 200);
  assert.equal(v.temps.bedTemp, 31);
  assert.equal(v.temps.targetBedTemp, 60);
});

test('buildPrinterView：缺料暂停 → paused 且文案是「暂停（耗材用尽）」', () => {
  const report = { ...printingReport, gcode_state: 'PAUSE', stg_cur: 6 };
  const state = resolveState(report);
  const v = buildPrinterView({ entry, report, state, now: Date.now(), locale: 'zh-CN' });
  assert.equal(v.statusClass, 'paused');
  assert.equal(state.labelKey, 'label.paused.runout');
  assert.equal(v.progress.percent, 42, '暂停时保留停在哪一进度');
});

test('buildPrinterView：用户取消的任务不算失败（fail_reason=0x0300400C）', () => {
  const report = { ...printingReport, gcode_state: 'FAILED', fail_reason: 50348044 };
  const v = buildPrinterView({ entry, report, state: resolveState(report), now: Date.now() });
  assert.equal(v.statusClass, 'online', '取消后应回到空闲档，不显示「打印失败」');
});

test('buildPrinterView：离线帧 → offline，且不残留进度', () => {
  const report = { connected: false };
  const v = buildPrinterView({ entry, report, state: resolveState(report), now: Date.now() });
  assert.equal(v.statusClass, 'offline');
  assert.equal(v.progress.percent, null);
});

test('summarizeViews：逐类计数 + 打印中平均进度', () => {
  const mk = (statusClass, percent) => ({ statusClass, stateKey: 'x', progress: { percent } });
  const s = summarizeViews([
    mk('printing', 40), mk('printing', 60), mk('paused', 20),
    mk('failed', null), mk('online', null), mk('offline', null),
  ]);
  assert.equal(s.total, 6);
  assert.equal(s.printing, 2);
  assert.equal(s.paused, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.offline, 1);
  assert.equal(s.avgPercent, 50);
});

test('mergePrinters：云端与局域网同一台合并为 both，且优先走 LAN', () => {
  const merged = registry.mergePrinters(
    [{ serial: 'A', name: 'Cloud A', model: 'X1C', online: true, printStatus: null }],
    [{ serial: 'A', name: 'LAN A', model: 'X1C', host: '192.168.1.9' }],
  );
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'both');
  assert.equal(merged[0].host, '192.168.1.9');
  assert.equal(merged[0].name, 'LAN A', '局域网自定义名优先');
  assert.equal(registry.pickTransport(merged[0]), 'lan');
});

test('onlineRoseSerials：只上报「由不在线变在线」的上升沿', () => {
  const prev = [{ serial: 'A', online: false }, { serial: 'B', online: true }];
  const next = [{ serial: 'A', online: true }, { serial: 'B', online: true }, { serial: 'C', online: true }];
  assert.deepEqual(registry.onlineRoseSerials(prev, next), ['A', 'C']);
});

// ── 腔温 ──
// 机型能力清单来自 Bambu Studio 的机型配置（support_chamber_temp_control）：
// ✔ H2C / H2D / H2D Pro / H2S / X1E / X2D
// ✘ A1 / A1 mini / A2L / P1P / P1S / P2S / X1 / X1 Carbon

test('resolveChamberTemp：官方清单里带腔温的机型才显示', () => {
  const { resolveChamberTemp } = require('../src/core/printer-view');
  const packed = (40 << 16) | 42; // 低 16 位当前 42
  for (const model of ['H2C', 'H2D', 'H2S', 'X1E', 'X2D']) {
    assert.equal(resolveChamberTemp({ device: { ctc: { info: { temp: packed } } } }, model), 42, model);
  }
  // 型号串的写法差异也要认（云端可能给 'H2D Pro' / 带空格）
  for (const model of ['H2D Pro', 'h2d-pro', 'H2DPRO']) {
    assert.equal(resolveChamberTemp({ chamber_temper: 41 }, model), 41, model);
  }
});

test('resolveChamberTemp：清单外的机型一律不显示，哪怕字段里有数', () => {
  const { resolveChamberTemp } = require('../src/core/printer-view');
  // A1 / P1S / P1Sc 实测：室温 21–24°C 时报 chamber_temper=5，同一个占位常量
  for (const model of ['A1', 'A1 mini', 'A1mini', 'P1P', 'P1S', 'P1Sc', 'P2S', 'A2L']) {
    assert.equal(resolveChamberTemp({ chamber_temper: 5 }, model), null, `${model} 不该显示腔温`);
  }
  // X1 Carbon 没有腔温 —— 名字带 X1 但不带腔温控制器，这条最容易搞错
  assert.equal(resolveChamberTemp({ chamber_temper: 34 }, 'X1C'), null);
  assert.equal(resolveChamberTemp({ chamber_temper: 34 }, 'X1 Carbon'), null);
  // 型号未知 / 缺失（例如只配了局域网、云端没回型号）时不猜
  assert.equal(resolveChamberTemp({ chamber_temper: 34 }, ''), null);
  assert.equal(resolveChamberTemp({ chamber_temper: 34 }, null), null);
});

test('resolveChamberTemp：device.ctc 覆盖清单，新机型不必改代码', () => {
  const { resolveChamberTemp } = require('../src/core/printer-view');
  // 假想新机型 X9 不在清单里，但报文带腔温控制器 → 采信实测值
  assert.equal(
    resolveChamberTemp({ chamber_temper: 5, device: { ctc: { info: { temp: (40 << 16) | 27 } } } }, 'X9'),
    27, // 只取低 16 位
  );
  // 同一帧里扁平字段是占位值时，ctc 优先
  assert.equal(
    resolveChamberTemp({ chamber_temper: 5, device: { ctc: { info: { temp: (40 << 16) | 42 } } } }, 'H2D'),
    42,
  );
});
