// 局域网直连：不经云端，直接连打印机自己开的 8883 端口（MQTT over TLS）。
//
// 为什么要这条通道：
//   · 云端链路依赖拓竹服务器 + 登录令牌，令牌过期、断外网、机房抖动都会失去状态；
//   · 局域网是打印机自己发的报文，延迟低一个数量级，且完全离线可用。
// 代价是打印机必须用「访问码」鉴权：设置 → 网络 → 局域网模式 里那 8 位字符。
//
// 与云端实现的三处差异：
//   1. 用户名固定 `bblp`，密码是访问码（不是 token）；
//   2. 证书是打印机自签的，必须跳过校验 —— 手写 rustls 验证器，
//      rumqttc 的 Native 后端做不到这件事；
//   3. 云端报文与局域网报文结构一致（都是 {"print": {...}} 的增量 diff），
//      所以合并逻辑直接复用 mqtt::merge_payload，不再写第二份。
//
// 另外带一个 SSDP 发现：拓竹打印机响应 239.255.255.250:1990 的 M-SEARCH，
// 回复里带序列号 / 机型 / 名称，能省掉用户去机器屏幕上抄序列号这一步。

use crate::state::AppState;
use rumqttc::{AsyncClient, Event, Incoming, MqttOptions, QoS, TlsConfiguration, Transport};
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::UdpSocket;

const LAN_PORT: u16 = 8883;
/// 定期补一帧 pushall：长时间没有 diff 时状态会陈旧（与云端同口径）。
const PUSH_EVERY: Duration = Duration::from_secs(5 * 60);
/// 断线多久之后才把设备标成离线。云端 + 局域网同时在线时，
/// 单条通道断掉不该让菜单栏瞬间变成「离线」——另一个通道可能刚给过数据。
const STALE_AFTER: Duration = Duration::from_secs(90);
const SSDP_ADDR: &str = "239.255.255.250:1990";

/// 一条局域网连接。`host` 可以是 IP 或 mDNS 名，`access_code` 是 8 位访问码。
pub fn spawn(app: AppHandle, state: Arc<AppState>, serial: String, host: String, access_code: String) {
    tauri::async_runtime::spawn(async move {
        let mut backoff = 3u64;
        loop {
            if state.should_stop(&serial) {
                break;
            }
            let started = std::time::Instant::now();
            match run_session(&app, &state, &serial, &host, &access_code).await {
                Ok(()) => break, // 被显式停止
                Err(e) => {
                    eprintln!("[lan] {serial}@{host}: {e}");
                    state.set_conn_error(&serial, &e);
                    let _ = app.emit("conn-error", json!({ "serial": serial, "error": e, "source": "lan" }));
                    state.set_offline_if_stale(&serial, STALE_AFTER);
                    // 连上过就重置退避，连不上则指数退避到 30 秒，别把日志刷爆。
                    if started.elapsed() > Duration::from_secs(20) {
                        backoff = 3;
                    }
                }
            }
            tokio::time::sleep(Duration::from_secs(backoff)).await;
            backoff = (backoff * 2).min(30);
        }
    });
}

async fn run_session(
    app: &AppHandle,
    state: &Arc<AppState>,
    serial: &str,
    host: &str,
    access_code: &str,
) -> Result<(), String> {
    let client_id = format!("bambubar{}{}", &serial.chars().rev().take(6).collect::<String>(), "lan");
    let mut opts = MqttOptions::new(client_id, host, LAN_PORT);
    opts.set_credentials("bblp", access_code);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_transport(Transport::tls_with_config(TlsConfiguration::Rustls(insecure_tls())));

    let (client, mut eventloop) = AsyncClient::new(opts, 64);
    let topic = format!("device/{serial}/report");
    let req_topic = format!("device/{serial}/request");

    let mut subscribed = false;
    let mut last_push = tokio::time::Instant::now() - PUSH_EVERY;
    let mut push_rx = state.push_channel(serial).subscribe();

    loop {
        if state.should_stop(serial) {
            let _ = client.disconnect().await;
            return Ok(());
        }
        while push_rx.try_recv().is_ok() {
            if subscribed {
                let _ = client.publish(req_topic.clone(), QoS::AtMostOnce, false, pushall_body()).await;
                last_push = tokio::time::Instant::now();
            }
        }

        match tokio::time::timeout(Duration::from_secs(1), eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Incoming::ConnAck(_)))) => {
                client.subscribe(topic.clone(), QoS::AtMostOnce).await.map_err(|e| e.to_string())?;
                subscribed = true;
                state.set_online(serial, true);
                let _ = client.publish(req_topic.clone(), QoS::AtMostOnce, false, pushall_body()).await;
                last_push = tokio::time::Instant::now();
            }
            Ok(Ok(Event::Incoming(Incoming::Publish(p)))) => {
                if let Some(report) = crate::mqtt::merge_payload(state, serial, &p.payload) {
                    state.set_online(serial, true);
                    let _ = app.emit("report", json!({ "serial": serial, "report": report, "source": "lan" }));
                }
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("lan mqtt: {e}")),
            Err(_) => {
                if subscribed && last_push.elapsed() >= PUSH_EVERY {
                    let _ = client.publish(req_topic.clone(), QoS::AtMostOnce, false, pushall_body()).await;
                    last_push = tokio::time::Instant::now();
                }
            }
        }
    }
}

fn pushall_body() -> Vec<u8> {
    serde_json::to_vec(&json!({
        "pushing": { "sequence_id": "0", "command": "pushall" }
    }))
    .unwrap_or_default()
}

// ───────────────────────────── TLS ─────────────────────────────

/// 打印机用自签证书，主机名还是它自己的 IP——校验链没有任何意义，
/// 真正的鉴权是 MQTT 的 `bblp` + 访问码。这里显式跳过证书校验，
/// 但签名算法本身仍然走 rustls 的实现（不手写密码学）。
fn insecure_tls() -> Arc<rustls::ClientConfig> {
    #[derive(Debug)]
    struct AcceptAny(Arc<rustls::crypto::CryptoProvider>);

    impl rustls::client::danger::ServerCertVerifier for AcceptAny {
        fn verify_server_cert(
            &self,
            _end_entity: &rustls::pki_types::CertificateDer<'_>,
            _intermediates: &[rustls::pki_types::CertificateDer<'_>],
            _server_name: &rustls::pki_types::ServerName<'_>,
            _ocsp_response: &[u8],
            _now: rustls::pki_types::UnixTime,
        ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls12_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn verify_tls13_signature(
            &self,
            message: &[u8],
            cert: &rustls::pki_types::CertificateDer<'_>,
            dss: &rustls::DigitallySignedStruct,
        ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
            rustls::crypto::verify_tls13_signature(
                message,
                cert,
                dss,
                &self.0.signature_verification_algorithms,
            )
        }

        fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
            self.0.signature_verification_algorithms.supported_schemes()
        }
    }

    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let cfg = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .expect("rustls 默认协议版本")
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAny(provider)))
        .with_no_client_auth();
    Arc::new(cfg)
}

// ───────────────────────────── 发现 ─────────────────────────────

#[derive(Debug, Clone, serde::Serialize)]
pub struct Found {
    pub serial: String,
    pub host: String,
    pub model: String,
    pub name: String,
}

/// SSDP 扫一遍局域网。超时是硬性预算：没装打印机/没开局域网模式时
/// 只能等到超时，不能让设置页转圈转到天荒地老。
pub async fn discover(timeout: Duration) -> Vec<Found> {
    let mut out: Vec<Found> = Vec::new();
    let Ok(sock) = UdpSocket::bind("0.0.0.0:0").await else { return out };
    let _ = sock.set_broadcast(true);
    let _ = sock.set_multicast_ttl_v4(2);

    let req = concat!(
        "M-SEARCH * HTTP/1.1\r\n",
        "HOST: 239.255.255.250:1990\r\n",
        "MAN: \"ssdp:discover\"\r\n",
        "MX: 2\r\n",
        "ST: urn:bambulab-com:device:3dprinter:1\r\n\r\n"
    );
    if sock.send_to(req.as_bytes(), SSDP_ADDR).await.is_err() {
        return out;
    }

    let deadline = tokio::time::Instant::now() + timeout;
    let mut buf = [0u8; 4096];
    loop {
        let left = deadline.saturating_duration_since(tokio::time::Instant::now());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(left, sock.recv_from(&mut buf)).await {
            Ok(Ok((n, peer))) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                if let Some(f) = parse_ssdp(&text, &peer.ip().to_string()) {
                    if !out.iter().any(|x| x.serial == f.serial) {
                        out.push(f);
                    }
                }
            }
            _ => break,
        }
    }
    out
}

/// 解析 SSDP 回复。拓竹的字段名不完全统一（固件版本之间有出入），
/// 所以序列号不认字段名，直接在整段回复里找 15 位大写字母数字串——
/// 机型/名称才按 `DevModel.bambu.com` / `DevName.bambu.com` 取。
fn parse_ssdp(text: &str, peer: &str) -> Option<Found> {
    let mut model = String::new();
    let mut name = String::new();
    let mut host = peer.to_string();

    for line in text.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let (k, v) = (k.trim().to_ascii_lowercase(), v.trim().to_string());
        match k.as_str() {
            "devmodel.bambu.com" => model = friendly_model(&v),
            "devname.bambu.com" => name = v,
            "location" => {
                if !v.is_empty() {
                    // Location 有时是完整 URL，只要主机部分
                    let h = v.trim_start_matches("http://").trim_start_matches("https://");
                    host = h.split('/').next().unwrap_or(&v).to_string();
                }
            }
            _ => {}
        }
    }

    let serial = find_serial(text)?;
    Some(Found { serial, host, model, name })
}

fn find_serial(text: &str) -> Option<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .find(|t| t.len() == 15 && t.chars().all(|c| c.is_ascii_digit() || c.is_ascii_uppercase()))
        .map(|s| s.to_string())
}

fn friendly_model(code: &str) -> String {
    match code {
        "BL-P001" => "X1C".into(),
        "BL-P002" => "X1".into(),
        "C11" => "P1P".into(),
        "C12" => "P1S".into(),
        "C13" => "P1S".into(),
        "N1" => "A1mini".into(),
        "N2S" => "A1".into(),
        "O1D" | "O1D2" => "H2D".into(),
        other => other.to_string(),
    }
}

/// 试连一次：只等 CONNACK。给设置页的「测试连接」用——
/// 端口通不通、访问码对不对，在添加之前就要有结论。
pub async fn probe(host: &str, serial: &str, access_code: &str) -> Result<(), String> {
    let client_id = format!("bambubar{}{}", &serial.chars().rev().take(6).collect::<String>(), "tst");
    let mut opts = MqttOptions::new(client_id, host, LAN_PORT);
    opts.set_credentials("bblp", access_code);
    opts.set_keep_alive(Duration::from_secs(15));
    opts.set_transport(Transport::tls_with_config(TlsConfiguration::Rustls(insecure_tls())));

    let (_client, mut eventloop) = AsyncClient::new(opts, 8);
    match tokio::time::timeout(Duration::from_secs(8), eventloop.poll()).await {
        Ok(Ok(Event::Incoming(Incoming::ConnAck(_)))) => Ok(()),
        Ok(Ok(_)) => Ok(()),
        Ok(Err(e)) => Err(describe(&e.to_string())),
        Err(_) => Err("连接超时：打印机可能不在同一网段，或没开「局域网模式」".into()),
    }
}

fn describe(e: &str) -> String {
    let low = e.to_lowercase();
    if low.contains("notauthorized") || low.contains("bad user name or password") {
        return "访问码不正确（在打印机屏幕：设置 → 网络 → 局域网模式）".into();
    }
    if low.contains("connection refused") || low.contains("os error 61") {
        return "端口 8883 连不上：确认 IP 正确，且打印机已开启局域网模式".into();
    }
    if low.contains("timed out") || low.contains("timeout") {
        return "连接超时：打印机可能不在同一网段".into();
    }
    format!("连接失败：{e}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serial_is_found_regardless_of_field_name() {
        // 不同固件的字段名不一样，所以按 15 位序列号特征找
        let reply = "HTTP/1.1 200 OK\r\n\
                     Location: 192.168.1.23\r\n\
                     USN: 00M09A440100123\r\n\
                     DevModel.bambu.com: C12\r\n\
                     DevName.bambu.com: Bambu P1S\r\n\r\n";
        let f = parse_ssdp(reply, "192.168.1.23:1990").expect("parse");
        assert_eq!(f.serial, "00M09A440100123");
        assert_eq!(f.model, "P1S");
        assert_eq!(f.name, "Bambu P1S");
        assert_eq!(f.host, "192.168.1.23");
    }

    #[test]
    fn ssdp_without_serial_is_ignored() {
        let reply = "HTTP/1.1 200 OK\r\nDevModel.bambu.com: C12\r\n\r\n";
        assert!(parse_ssdp(reply, "10.0.0.2").is_none());
    }

    #[test]
    fn friendly_model_covers_common_boxes() {
        assert_eq!(friendly_model("C12"), "P1S");
        assert_eq!(friendly_model("N2S"), "A1");
        assert_eq!(friendly_model("ZZZ"), "ZZZ");
    }
}
