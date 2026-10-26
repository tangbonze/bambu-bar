// 打印机状态 → 面板视图模型（纯函数，无 electron 依赖，便于单测）。
//
// 这是「菜单栏面板显示什么」的唯一事实来源：温度 / 进度 / 层数 / 剩余时间 / 预计完成时刻 /
// 耗材与 AMS 槽位 / HMS 错误 / 失败原因 / 任务名 / 速度档 / WiFi / 舱门 / 风扇……
// 全部从合并后的 MQTT 报文里取，字段名以 pybambu 为事实来源（与 state-machine 一致）。
//
// 为什么单独成模块：主进程只负责「连、聚合、节流推送」，不做字段解析；渲染层只负责画。
// 这样字段兼容逻辑（新固件 device.* 打包温度 vs 老固件扁平字段）只存在一份，可单测。

const { extractTemps, fmtRemain } = require('./state-machine');
const { statusClassFromStateKey } = require('./live-telemetry');
const { resolveFilamentColor } = require('./filament-color');
const { dayOffset } = require('./day-offset');

// Bambu 速度档：spd_lvl 1–4（静音/标准/运动/狂暴），spd_mag 为百分比倍率。
const SPEED_LEVELS = { 1: 'silent', 2: 'standard', 3: 'sport', 4: 'ludicrous' };

// AMS 湿度档（0–5，越低越干）。数值来源 pybambu / BambuStudio 的湿度指示。
const HUMIDITY_LABELS = ['dry', 'dryish', 'normal', 'humid', 'wetter', 'wet'];

const TRAY_NOW_NONE = 255;
const TRAY_NOW_EXTERNAL = 254;

// RRGGBBAA → '#rrggbb'。alpha=00 是「无颜色」哨兵（空槽 / 外挂未设色），必须判 null，
// 否则会被当成真·黑色（真黑是 000000FF）。
function parseColor(raw) {
  if (typeof raw !== 'string' || raw.length < 6) return null;
  const rgb = raw.slice(0, 6);
  if (!/^[0-9a-fA-F]{6}$/.test(rgb)) return null;
  if (raw.slice(6, 8) === '00') return null;
  return '#' + rgb.toLowerCase();
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ─────────────────────────── 腔温 ───────────────────────────
// 只有**真带腔温控制**的机型才显示腔温，其余机型整行不显示。
//
// 机型清单的来源是 Bambu Studio 自己的机型配置（`resources/profiles/BBL/machine/*.json`
// 里的 `support_chamber_temp_control`，切片器判断要不要显示腔温用的就是它）。
// 本机 BambuStudio 02.08.02.61 的实测结果：全局默认值为 0（`fdm_machine_common`），
// 只有下面 6 个机型把它重写为 1：
//     H2C · H2D · H2D Pro · H2S · X1E · X2D
// 而 A1 / A1 mini / A2L / P1P / P1S / P2S / X1 / X1 Carbon 全部为 0。
// ⚠️ 特别注意 X1 Carbon 是 **0** —— 它没有腔温，虽然名字里带 X1。
//
// 为什么还需要运行时判据：清单会过期（新机型上市、旧机型新增模块），所以
// `device.ctc.info.temp`（固件里的 Chamber Temperature Control，int 打包：
// 低 16 位=当前 / 高 16 位=目标）存在时直接采信，不看清单。
//
// 为什么不能用扁平 `chamber_temper` 反推能力：A1 / P1S / P1Sc 三台实测，在喷嘴 21–24°C、
// 热床 21–22°C（即室温）时都报 `chamber_temper: 5` —— 三台同一个常量、与各自环境无关，
// 说明固件在没有传感器时填的是占位值。早前版本把它当温度显示，于是「没有腔温的机器」
// 显示了一个假温度。
const CHAMBER_MODELS = new Set(['H2C', 'H2D', 'H2DPRO', 'H2S', 'X1E', 'X2D']);

/**
 * 型号归一化，用于清单匹配：'A1 mini' / 'a1-mini' / 'Bambu Lab A1 mini' → 'A1MINI'。
 * 云端返回的型号串与配置里的型号名并不完全一致（X1C / X1 Carbon、A1mini / A1 mini），
 * 所以只做「去掉分隔符 + 大写」，不做别名表 —— 清单里都是短码，短码能直接对上。
 */
function modelKey(model) {
  return String(model || '')
    .replace(/^Bambu\s*Lab\s*/i, '')
    .toUpperCase()
    .replace(/[\s_-]/g, '');
}

/**
 * 该报文的腔温（°C）。机型不带腔温时返回 null —— 调用方据此整行不显示。
 * @param {object} report - 已合并的 MQTT 报文
 * @param {string} [model] - 机型（云端返回的短码，如 'H2D' / 'P1S' / 'X1C'）
 * @returns {number|null}
 */
function resolveChamberTemp(report, model) {
  const r = report || {};
  // 有腔温控制器 → 采信实测值（覆盖清单里没收录的新机型）
  const packed = r.device && r.device.ctc && r.device.ctc.info && r.device.ctc.info.temp;
  if (Number.isFinite(packed)) return Math.round(packed & 0xffff);
  // 机型本身不带腔温 → 报文里那个 chamber_temper 是占位值，忽略
  if (!CHAMBER_MODELS.has(modelKey(model))) return null;
  const flat = num(r.chamber_temper) != null ? num(r.chamber_temper) : num(r.chamber_temp);
  return flat == null ? null : Math.round(flat);
}

/**
 * 提取全部 AMS 槽位 + 外挂料盘。
 * 返回 { units: [{ id, humidity, humidityText, temp, slots: [...] }], external: slot|null, activeKey }
 * slot = { key, color, type, remain, active, nozzleMin, nozzleMax }
 */
function extractFilament(report) {
  const r = report || {};
  const ams = r.ams || {};
  const unitsIn = Array.isArray(ams.ams) ? ams.ams : [];
  const trayNow = num(ams.tray_now);

  // 当前正在使用的槽位 key（与下面 slot.key 同构）：amsId:slotId / ext:slotId
  let activeKey = null;
  if (trayNow === TRAY_NOW_EXTERNAL) {
    activeKey = 'ext:254';
  } else if (trayNow != null && trayNow !== TRAY_NOW_NONE) {
    activeKey = `${Math.floor(trayNow / 4)}:${trayNow % 4}`;
  }

  const units = unitsIn.map((u, ui) => {
    const id = num(u && u.id) != null ? num(u.id) : ui;
    const traysIn = Array.isArray(u && u.tray) ? u.tray : [];
    const slots = traysIn.map((t, ti) => {
      const slotId = num(t && t.id) != null ? num(t.id) : ti;
      const key = `${id}:${slotId}`;
      return {
        key,
        amsId: id,
        slotId,
        color: parseColor(t && t.tray_color),
        type: (t && (t.tray_type || t.tray_id_name)) || null,
        // remain：-1 = 未知（真机常见），0–100 = 百分比
        remain: num(t && t.remain),
        active: key === activeKey,
        nozzleMin: num(t && t.nozzle_temp_min),
        nozzleMax: num(t && t.nozzle_temp_max),
      };
    });
    const hum = num(u && u.humidity);
    return {
      id,
      humidity: hum,
      humidityText: hum != null ? HUMIDITY_LABELS[hum] || null : null,
      temp: num(u && u.temp),
      slots,
    };
  });

  // 外挂料盘：单喷头机是对象，双喷头机可能是数组（按 id 定位，定位不到取第一条）。
  let external = null;
  const vt = r.vt_tray;
  const vtList = Array.isArray(vt) ? vt : (vt ? [vt] : []);
  if (vtList.length) {
    const t = vtList.find((x) => x && num(x.id) === TRAY_NOW_EXTERNAL) || vtList[0];
    const slotId = num(t && t.id) != null ? num(t.id) : TRAY_NOW_EXTERNAL;
    external = {
      key: 'ext:' + slotId,
      amsId: null,
      slotId,
      color: parseColor(t && t.tray_color),
      type: (t && (t.tray_type || t.tray_id_name)) || null,
      remain: num(t && t.remain),
      active: activeKey === 'ext:' + slotId || activeKey === 'ext:' + TRAY_NOW_EXTERNAL,
      nozzleMin: num(t && t.nozzle_temp_min),
      nozzleMax: num(t && t.nozzle_temp_max),
    };
  }

  // 双喷头 / 外挂使用中：tray_now 指不到 AMS 槽时，用 extruder.snow 反查活动槽（与
  // filament-color 的解法同源）。只用于「哪个槽在出料」的高亮，不改变取色结论。
  if (!activeKey) {
    const info = r.device && r.device.extruder && r.device.extruder.info;
    const loaded = Array.isArray(info) ? info.find((e) => e && num(e.snow) != null && num(e.snow) !== 0xffff && num(e.stat)) : null;
    if (loaded) {
      const snow = num(loaded.snow);
      const amsId = (snow >> 8) & 0xff;
      const slotId = snow & 0xff;
      activeKey = amsId === TRAY_NOW_EXTERNAL || amsId === 255 ? `ext:${slotId}` : `${amsId}:${slotId}`;
      for (const u of units) for (const s of u.slots) s.active = s.key === activeKey;
      if (external) external.active = external.key === activeKey;
    }
  }

  const count = units.reduce((n, u) => n + u.slots.length, 0) + (external ? 1 : 0);
  return { units, external, activeKey, count };
}

// 剩余分钟 → 预计完成时刻文案（本机时区），跨自然日标 +1/+2。
function formatEta(remainMins, nowMs, locale) {
  if (!Number.isFinite(remainMins) || remainMins <= 0) return null;
  const eta = nowMs + remainMins * 60000;
  const d = new Date(eta);
  const opts = { hour: '2-digit', minute: '2-digit' };
  let text;
  try {
    text = d.toLocaleTimeString(/^zh/i.test(locale || '') ? 'zh-CN' : 'en-US', opts);
  } catch {
    text = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const offset = dayOffset(nowMs, eta);
  return { text, offset, dayOffset: offset > 0 ? `+${offset}` : '' };
}

// 报文中可展示的 HMS 码（attr 高 8 hex + code 低 8 hex，与官方码表查表口径一致）。
function extractHms(report) {
  const list = Array.isArray(report && report.hms) ? report.hms : [];
  return list
    .filter((h) => h && Number.isFinite(h.attr) && Number.isFinite(h.code))
    .map((h) => ({
      code: (h.attr >>> 0).toString(16).toUpperCase().padStart(8, '0')
        + (h.code >>> 0).toString(16).toUpperCase().padStart(8, '0'),
    }));
}

// 风扇转速（0–100 或 0–255，真机多为 0–100 的百分比；>100 时按 255 归一）。
function normPct(v) {
  const n = num(v);
  if (n == null) return null;
  if (n > 100) return Math.round((n / 255) * 100);
  return Math.round(n);
}

/**
 * 组装单台的完整视图模型。
 * @param {object} o
 * @param {object} o.entry  - 统一注册表条目 { serial,name,model,source,hasCloud,hasLan,host,online }
 * @param {object} o.report - 最近一帧合并报文（可能为 null = 尚未收到）
 * @param {object} o.state  - resolveState 输出（已含 labelKey/labelParams/stateKey）
 * @param {number} [o.now]  - 当前时刻（测试注入）
 * @param {object} [o.reason] - { text, category, hmsTexts: {code: text} }
 * @param {string} [o.locale]
 * @param {boolean} [o.hidden]
 * @returns {object}
 */
function buildPrinterView({ entry, report, state, now = Date.now(), reason = null, locale = 'zh-CN', hidden = false }) {
  const e = entry || {};
  const r = report || {};
  const st = state || {};
  const temps = { ...extractTemps(r), chamberTemp: resolveChamberTemp(r, e.model) };
  const filament = extractFilament(r);
  const percent = num(r.mc_percent);
  const remainMins = temps.remainingTime;
  const eta = formatEta(remainMins, now, locale);
  const spdLvl = num(r.spd_lvl);
  const hms = extractHms(r);

  return {
    serial: e.serial || null,
    name: e.name || e.serial || '?',
    model: e.model || '',
    source: e.source || (e.hasLan ? 'lan' : 'cloud'),
    host: e.host || null,
    online: e.online !== undefined ? e.online : null,
    hidden: !!hidden,
    connected: !!(r.connected !== false && Object.keys(r).length),
    stateKey: st.stateKey || null,
    statusClass: statusClassFromStateKey(st.stateKey),
    labelKey: st.labelKey || null,
    labelParams: st.labelParams || {},
    // 原始报文里的业务字段，渲染层直接展示
    job: r.subtask_name || r.gcode_file || r.file || null,
    gcodeState: r.gcode_state || null,
    progress: {
      percent,
      layer: num(r.layer_num),
      total: num(r.total_layer_num),
      remainMins: Number.isFinite(remainMins) ? remainMins : null,
      remainText: fmtRemain(remainMins),
      etaText: eta ? eta.text : null,
      etaDayOffset: eta ? eta.dayOffset : '',
      etaInDays: eta ? eta.offset : 0,
      printType: r.print_type || null,
    },
    temps,
    filament: {
      current: resolveFilamentColor(r),
      amsCount: filament.count,
      units: filament.units,
      external: filament.external,
      activeKey: filament.activeKey,
    },
    speed: {
      lvl: spdLvl,
      level: spdLvl ? SPEED_LEVELS[spdLvl] || null : null,
      mag: num(r.spd_mag),
    },
    fans: {
      part: normPct(r.cooling_fan_speed),
      aux: normPct(r.big_fan1_speed),
      chamber: normPct(r.big_fan2_speed),
      heatbreak: normPct(r.heatbreak_fan_speed),
    },
    nozzle: {
      diameter: num(r.nozzle_diameter),
      type: r.nozzle_type || null,
      count: Array.isArray(r.device && r.device.extruder && r.device.extruder.info)
        ? r.device.extruder.info.length : null,
    },
    wifi: num(r.wifi_signal),
    doorOpen: r.door_open === true,
    light: Array.isArray(r.lights_report)
      ? (r.lights_report.find((l) => l && /chamber/i.test(l.node || '')) || {}).mode || null
      : null,
    hms,
    failReason: num(r.fail_reason),
    error: reason ? {
      text: reason.text || null,
      category: reason.category || null,
      hmsTexts: reason.hmsTexts || {},
    } : null,
    updatedAt: now,
    raw: r,
  };
}

/** 汇总：台数 / 各状态计数 / 平均进度（仅供表头一行摘要）。 */
function summarizeViews(views) {
  const s = {
    total: 0, printing: 0, paused: 0, failed: 0, finished: 0, idle: 0, offline: 0, preparing: 0,
    avgPercent: null, activeSerial: null,
  };
  let pSum = 0; let pN = 0;
  for (const v of views || []) {
    s.total += 1;
    switch (v.statusClass) {
      case 'printing': s.printing += 1; break;
      case 'paused': s.paused += 1; break;
      case 'failed': s.failed += 1; break;
      case 'finished': s.finished += 1; break;
      case 'offline': s.offline += 1; break;
      case 'online': s.idle += 1; break;
      default: break;
    }
    if (v.stateKey === 'prepare') s.preparing += 1;
    if (v.statusClass === 'printing' && Number.isFinite(v.progress.percent)) {
      pSum += v.progress.percent; pN += 1;
    }
  }
  if (pN) s.avgPercent = Math.round(pSum / pN);
  return s;
}

module.exports = {
  buildPrinterView, summarizeViews, extractFilament, extractHms,
  resolveChamberTemp, CHAMBER_MODELS,
  formatEta, parseColor, SPEED_LEVELS, HUMIDITY_LABELS,
};
