// 演示模式：没有账号 / 没有打印机时也能把「菜单栏 + 面板」完整跑一遍。
//
// 为什么要放在 Rust 侧：面板的假数据由前端 Core.demo 生成（要喂给 buildPrinterView
// 才能长出手册级的 AMS 图谱），但**菜单栏标题**是 Rust 算的——不在这里造数据，
// 演示模式就只剩一个空图标，断言的「轮播 / 定宽 / 失败优先级」全都验不了。
//
// 设计约束：演示模式**绝不写配置**。设备清单在这里是「虚拟清单」，由
// `demo::entries()` 提供给 bootstrap 与 tray_items；真实账号下的 printers 原样躺在
// 配置里，关掉演示开关就立刻回来。早期版本把假设备塞进 cfg.printers，结果一开演示
// 再保存配置就把用户的真机列表覆盖了。

use crate::state::AppState;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::AppHandle;

/// 四台假设备。机型名刻意挑会拉宽标题的那几个（X1C / P1S / A1mini），
/// 因为定宽补白的边缘情况正是「长机型 + 100%」这类组合。
pub const DEMO: &[(&str, &str, &str)] = &[
    ("00M09A350100001", "X1 Carbon", "X1C"),
    ("01S00C350200002", "工作间 P1S", "P1S"),
    ("0300CA350300003", "A1 mini", "A1mini"),
    ("09400A350400004", "H2D", "H2D"),
];

/// 虚拟设备清单：(serial, name, model)。
pub fn entries() -> Vec<(String, String, String)> {
    DEMO.iter()
        .map(|(s, n, m)| (s.to_string(), n.to_string(), m.to_string()))
        .collect()
}

/// 按顺序分配四种形态，保证一眼能看出「谁在轮播、谁不轮播、谁在报警」。
fn shape(i: usize, serial: String) -> (&'static str, f64, f64, String) {
    let (state, percent, remain) = match i % 4 {
        0 => ("RUNNING", 42.0, 83.0),
        1 => ("RUNNING", 78.0, 21.0),
        2 => ("PAUSE", 61.0, 46.0),
        _ => ("FINISH", 100.0, 0.0),
    };
    (state, percent, remain, serial)
}

pub fn start(_app: &AppHandle, state: &Arc<AppState>) {
    // 幂等：设置窗口里反复勾选「演示模式」不应该叠出多条循环。
    if state.demo_started.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    let targets: Vec<_> = DEMO
        .iter()
        .enumerate()
        .map(|(i, (serial, _, _))| shape(i, serial.to_string()))
        .collect();

    let st = state.clone();
    tauri::async_runtime::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(2));
        let mut step = 0u64;
        loop {
            tick.tick().await;
            for (state_name, base_pct, base_remain, serial) in &targets {
                // 打印中的机器缓慢推进；暂停/完成的保持不动 —— 盯着菜单栏就能看出
                // 「轮播在走、进度在涨、完成的那台不参与轮播」。
                let (pct, remain) = if *state_name == "RUNNING" {
                    ((base_pct + step as f64 * 0.4) % 100.0, (base_remain - step as f64 * 0.2).max(1.0))
                } else {
                    (*base_pct, *base_remain)
                };
                let report = json!({
                    "connected": true,
                    "gcode_state": state_name,
                    "mc_percent": (pct * 10.0).round() / 10.0,
                    "mc_remaining_time": (remain * 10.0).round() / 10.0,
                    "subtask_name": if *state_name == "RUNNING" { "benchy-hollow-v3.3mf" } else { "" },
                });
                st.set_online(serial, true);
                st.with_printer(serial, |ps| {
                    ps.report = Some(report);
                    ps.last_seen = Some(std::time::Instant::now());
                });
            }
            step += 1;
        }
    });
}
