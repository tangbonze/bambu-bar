// 单台打印机的运行时状态：合并后的报文 + 几个跨帧的持久标记。

use serde_json::Value;
use std::time::Instant;

#[derive(Default)]
pub struct PrinterState {
    /// 已合并的完整报文（增量 diff 合并结果）。
    pub report: Option<Value>,
    /// 「本次终止是用户取消」——取消事件是瞬时的，但 gcode_state 会粘滞 FAILED，
    /// 必须持久记住，否则菜单栏会一直喊「打印失败」。
    pub canceled: bool,
    pub online: bool,
    /// 最近一次收到报文的时间（判断陈旧）。
    pub last_seen: Option<Instant>,
}

impl PrinterState {
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.report.as_ref().and_then(|r| r.get(key))
    }
    pub fn str_of(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(|v| v.as_str())
    }
    pub fn num_of(&self, key: &str) -> Option<f64> {
        self.get(key).and_then(|v| v.as_f64())
    }
}
