// 打包入口：把 `src/` 下的**纯逻辑**核心模块打进 WebView。
//
// 这些模块是 Electron 版原样留下的（同一个仓库、同一份文件，不是复制品）：
// 状态机/视图模型经过真机校准（固件字段兼容、AMS 空槽语义、完成记忆、失败码归类），
// 重写成 Rust 只会多出一份可能漂移的实现。
// 传输层（MQTT/鉴权）在 Rust，这里只做「报文 → 视图」的纯函数计算。

const { resolveState, isPrintActive } = require('../src/core/state-machine');
const { buildPrinterView, summarizeViews } = require('../src/core/printer-view');
const { applyCompletionState } = require('../src/core/completion-state');
const { StateStabilizer } = require('../src/core/state-stabilizer');
const { bundle, t } = require('../src/config/ui-strings');
const demo = require('../src/dev/demo-data');

window.BambuCore = {
  resolveState,
  isPrintActive,
  buildPrinterView,
  summarizeViews,
  applyCompletionState,
  StateStabilizer,
  bundle,
  t,
  demo,
};
