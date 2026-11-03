// 云 MQTT 数据源：token + uid → cn/us.mqtt.bambulab.com:8883，订阅 device/<serial>/report。
//
// 关键行为与 Electron 版 src/core/bambu-mqtt.js 保持一致：
//   1. 订阅后立即发一次 pushall —— 拓竹只在被请求时才回完整状态；
//   2. 报文是增量 diff，ams / vt_tray / device 必须**深合并**，否则 tray_now/tray_color
//      会被残缺帧冲掉，表现为耗材颜色周期性丢回默认绿；
//   3. 舱门态从 home_flag bit23 派生（真机不发 door_open 布尔）；
//   4. 用户取消打印用持久标记，避免 gcode_state 粘滞 FAILED 被当成故障。

use crate::state::AppState;
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS, TlsConfiguration, Transport};
use serde_json::{json, Map, Value};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

const TRAY_PUSHALL_EVERY: Duration = Duration::from_secs(5 * 60);

pub fn spawn_cloud(app: AppHandle, state: Arc<AppState>, serial: String, region: String, token: String, uid: String) {
    tauri::async_runtime::spawn(async move {
        // 单台机器的连接循环：rumqttc 自身会重连，外层再加一层兜底（进程级异常/令牌失效）。
        loop {
            if state.should_stop(&serial) {
                break;
            }
            let r = run_session(&app, &state, &serial, &region, &token, &uid).await;
            if let Err(e) = r {
                eprintln!("[mqtt] {serial}: {e}");
                state.set_conn_error(&serial, &e);
                let _ = app.emit("conn-error", json!({ "serial": serial, "error": e }));
            }
            tokio::time::sleep(Duration::from_secs(5)).await;
        }
    });
}

async fn run_session(
    app: &AppHandle,
    state: &Arc<AppState>,
    serial: &str,
    region: &str,
    token: &str,
    uid: &str,
) -> Result<(), String> {
    let host = crate::auth::mqtt_host(region);
    let username = if uid.starts_with("u_") { uid.to_string() } else { format!("u_{uid}") };
    let client_id = format!("bambubar{}", &serial.chars().rev().take(6).collect::<String>());

    let mut opts = MqttOptions::new(client_id, host, 8883);
    opts.set_credentials(username, token);
    opts.set_keep_alive(Duration::from_secs(60));
    opts.set_transport(Transport::Tls(TlsConfiguration::Native));

    let (client, mut eventloop) = AsyncClient::new(opts, 64);
    let topic = format!("device/{serial}/report");
    let req_topic = format!("device/{serial}/request");

    let mut subscribed = false;
    let mut last_push = tokio::time::Instant::now() - TRAY_PUSHALL_EVERY;
    // 面板「刷新」走的广播通道（Rust 侧的 request_pushall → 这里收到就立刻补一帧）。
    let mut push_rx = state.push_channel(serial).subscribe();

    loop {
        if state.should_stop(serial) {
            let _ = client.disconnect().await;
            return Ok(());
        }

        // 刷新请求：非阻塞取一次，有就立刻 pushall（用户点了按钮不该等 20 秒）。
        while push_rx.try_recv().is_ok() {
            if subscribed {
                let _ = client
                    .publish(req_topic.clone(), QoS::AtMostOnce, false, pushall_body())
                    .await;
                last_push = tokio::time::Instant::now();
            }
        }

        // 1 秒节拍：既用于拉刷新请求，也让 should_stop（退出/移除设备）及时生效。
        match tokio::time::timeout(Duration::from_secs(1), eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Incoming::ConnAck(_)))) => {
                client.subscribe(topic.clone(), QoS::AtMostOnce).await.map_err(|e| e.to_string())?;
                subscribed = true;
                state.set_online(serial, true);
                let _ = client
                    .publish(req_topic.clone(), QoS::AtMostOnce, false, pushall_body())
                    .await;
                last_push = tokio::time::Instant::now();
            }
            Ok(Ok(Event::Incoming(Incoming::Publish(p)))) => {
                if let Some(report) = merge_payload(state, serial, &p.payload) {
                    state.set_online(serial, true);
                    let _ = app.emit("report", json!({ "serial": serial, "report": report }));
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => {
                // 不直接判离线：局域网通道可能还在正常工作（见 set_offline_if_stale）。
                state.set_offline_if_stale(serial, Duration::from_secs(90));
                return Err(format!("mqtt: {e}"));
            }
            Err(_) => {
                // 空闲超时：定期补一次 pushall，防止长时间无帧导致状态陈旧
                if subscribed && last_push.elapsed() >= TRAY_PUSHALL_EVERY {
                    let _ = client
                        .publish(req_topic.clone(), QoS::AtMostOnce, false, pushall_body())
                        .await;
                    last_push = tokio::time::Instant::now();
                }
            }
        }
    }
}

/// pushall 请求体：拓竹只在被请求时才回完整状态。
fn pushall_body() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "pushing": { "sequence_id": "0", "command": "pushall" }
    }))
    .unwrap_or_default()
}

fn is_plain_object(v: &Value) -> bool { v.is_object() }

/// 按 id 合并对象数组。`tray` 有特殊语义：patch 条目只剩 {id} 表示该槽已空，
/// 必须整条替换而不是合并，否则退料后残留旧 tray_color。
fn merge_array_by_id(prev: &[Value], patch: &[Value], key: &str) -> Value {
    let has_id = |e: &Value| e.get("id").map(|v| !v.is_null()).unwrap_or(false);
    if !prev.iter().all(has_id) || !patch.iter().all(has_id) {
        return Value::Array(patch.to_vec());
    }
    let allow_emptied = key == "tray";
    let mut out: Vec<Value> = prev.to_vec();
    for entry in patch {
        let id = entry.get("id").cloned().unwrap_or(Value::Null);
        let pos = out.iter().position(|e| e.get("id") == Some(&id));
        let emptied = allow_emptied && entry.as_object().map(|o| o.len() == 1).unwrap_or(false);
        match pos {
            Some(i) => out[i] = if emptied { entry.clone() } else { deep_merge(&out[i], entry) },
            None => out.push(entry.clone()),
        }
    }
    Value::Array(out)
}

/// 递归合并：对象递归、对象数组按 id 合并、其余以 patch 为准。
pub fn deep_merge(prev: &Value, patch: &Value) -> Value {
    if !is_plain_object(prev) || !is_plain_object(patch) {
        return patch.clone();
    }
    let mut out: Map<String, Value> = prev.as_object().cloned().unwrap_or_default();
    for (k, v) in patch.as_object().unwrap() {
        let merged = match (out.get(k), v) {
            (Some(p), Value::Object(_)) if is_plain_object(p) => deep_merge(p, v),
            (Some(Value::Array(pa)), Value::Array(va)) => merge_array_by_id(pa, va, k),
            _ => v.clone(),
        };
        out.insert(k.clone(), merged);
    }
    Value::Object(out)
}

/// 把一帧 print 报文合并进该机的持久状态，返回合并后的完整报文（含派生字段）。
pub(crate) fn merge_payload(state: &Arc<AppState>, serial: &str, payload: &[u8]) -> Option<Value> {
    let msg: Value = serde_json::from_slice(payload).ok()?;
    let print = msg.get("print")?.clone();
    if !print.is_object() {
        return None;
    }

    state.with_printer(serial, |ps| {
        let prev = ps.report.clone().unwrap_or_else(|| json!({}));

        // 顶层浅合并 + 三棵子树深合并
        let mut latest = prev.clone();
        if let (Some(dst), Some(src)) = (latest.as_object_mut(), print.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
            dst.insert("connected".into(), json!(true));
        }
        for key in ["ams", "vt_tray", "device"] {
            if let Some(patch) = print.get(key).filter(|v| v.is_object()) {
                let merged = deep_merge(prev.get(key).unwrap_or(&Value::Null), patch);
                latest.as_object_mut().unwrap().insert(key.to_string(), merged);
            }
        }

        // 取消标记：开印事件清除、取消事件置位（先清后置，同帧以取消为准）。
        let g = print.get("gcode_state").and_then(|v| v.as_str()).unwrap_or("");
        if matches!(g, "RUNNING" | "PREPARE" | "SLICING") {
            ps.canceled = false;
        }
        if print.get("command").and_then(|v| v.as_str()) == Some("print_canceled") {
            ps.canceled = true;
        }
        if print.get("command").and_then(|v| v.as_str()) == Some("print_error")
            || print.get("print_error").and_then(|v| v.as_bool()).unwrap_or(false)
        {
            latest.as_object_mut().unwrap().insert("print_error".into(), json!(true));
        }
        if ps.canceled {
            latest.as_object_mut().unwrap().insert("print_canceled".into(), json!(true));
        }

        // 舱门：door_open 布尔 > home_flag bit23
        if let Some(b) = print.get("door_open").and_then(|v| v.as_bool()) {
            latest.as_object_mut().unwrap().insert("door_open".into(), json!(b));
        } else if let Some(flag) = latest.get("home_flag").and_then(|v| v.as_i64()) {
            latest.as_object_mut().unwrap().insert("door_open".into(), json!((flag & 0x0080_0000) != 0));
        }

        ps.report = Some(latest.clone());
        ps.last_seen = Some(std::time::Instant::now());
        Some(latest)
    })
}
