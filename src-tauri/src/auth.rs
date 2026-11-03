// Bambu Cloud 鉴权（非官方接口，字段以 pybambu 为事实来源）。
//
// 与 Electron 版 src/core/bambu-auth.js 一一对应：登录 / 短信验证码 / 设备列表 / 取 uid。
// 差异只有传输层：Electron 用 net（Chromium 网络栈）伪装浏览器指纹，这里用 reqwest
// + rustls，靠下面的 X-BBL-* 请求头通过服务端校验。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const BAMBU_HEADERS: &[(&str, &str)] = &[
    ("User-Agent", "bambu_network_agent/01.09.05.01"),
    ("X-BBL-Client-Name", "OrcaSlicer"),
    ("X-BBL-Client-Type", "slicer"),
    ("X-BBL-Client-Version", "01.09.05.51"),
    ("X-BBL-Language", "en-US"),
    ("X-BBL-OS-Type", "linux"),
    ("X-BBL-OS-Version", "6.2.0"),
    ("X-BBL-Agent-Version", "01.09.05.01"),
    ("X-BBL-Executable-info", "{}"),
    ("X-BBL-Agent-OS-Type", "linux"),
    ("Accept", "application/json"),
];

const LOGIN_PATH: &str = "/v1/user-service/user/login";
const DEVICE_LIST_PATH: &str = "/v1/iot-service/api/user/bind";
const PREFERENCE_PATH: &str = "/v1/design-user-service/my/preference";
/// 中国区短信验证码。必须走 api 域名：官网 bambulab.cn 被 Cloudflare 交互式挑战前置，
/// 非浏览器客户端一律 403（Electron 版实测结论，见其注释）。
const SMS_CODE_HOST: &str = "api.bambulab.cn";
const SMS_CODE_PATH: &str = "/v1/user-service/user/sendsmscode";

pub fn api_host(region: &str) -> &'static str {
    if region == "china" { "api.bambulab.cn" } else { "api.bambulab.com" }
}

pub fn mqtt_host(region: &str) -> &'static str {
    if region == "china" { "cn.mqtt.bambulab.com" } else { "us.mqtt.bambulab.com" }
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("http client")
}

async fn request(
    host: &str,
    path: &str,
    method: reqwest::Method,
    body: Option<Value>,
    bearer: Option<&str>,
) -> Result<Value, String> {
    let url = format!("https://{host}{path}");
    let mut req = client().request(method, &url);
    for (k, v) in BAMBU_HEADERS {
        req = req.header(*k, *v);
    }
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| {
        // 与 JS 版 humanizeError 对齐：网络类错误统一给 locale key
        if e.is_timeout() || e.is_connect() {
            "auth.errNetwork".to_string()
        } else {
            format!("auth.errNetwork: {e}")
        }
    })?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
    if !status.is_success() {
        let snippet: String = text.chars().take(200).collect();
        return Err(match status.as_u16() {
            401 | 403 => "auth.errBadCredentials".to_string(),
            _ => format!("HTTP {}: {}", status.as_u16(), snippet.replace('\n', " ")),
        });
    }
    if parsed.is_null() {
        return Err(format!("Unexpected non-JSON response: {}", text.chars().take(200).collect::<String>()));
    }
    Ok(parsed)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoginOk {
    pub token: String,
    pub uid: String,
    pub account: String,
    /// 需要邮箱/2FA 验证码时返回 true，前端应切到验证码输入。
    #[serde(default)]
    pub needs_verify: bool,
    #[serde(default)]
    pub tfa_key: String,
}

/// 从 JWT 粗略取 uid（国际区 token 是 JWT，中国区不透明）。
pub fn decode_uid_from_token(token: &str) -> Option<String> {
    let payload = token.split('.').nth(1)?;
    let raw = base64_url_decode(payload)?;
    let v: Value = serde_json::from_slice(&raw).ok()?;
    v.get("username").or_else(|| v.get("sub")).or_else(|| v.get("uid"))
        .and_then(|x| x.as_str().map(|s| s.to_string()))
        .or_else(|| v.get("uid").and_then(|x| x.as_u64()).map(|n| n.to_string()))
}

fn base64_url_decode(s: &str) -> Option<Vec<u8>> {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = Vec::new();
    let mut buf: u32 = 0;
    let mut bits = 0;
    for c in s.bytes() {
        if c == b'=' { break; }
        let v = TABLE.iter().position(|&t| t == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Some(out)
}

pub async fn login(region: &str, account: &str, password: &str) -> Result<LoginOk, String> {
    if account.is_empty() || password.is_empty() {
        return Err("auth.errAccountPasswordRequired".into());
    }
    let res = request(
        api_host(region), LOGIN_PATH, reqwest::Method::POST,
        Some(json!({ "account": account, "password": password })), None,
    ).await?;
    if res.get("loginType").and_then(|v| v.as_str()) == Some("verifyCode") || res.get("tfaKey").is_some() {
        return Ok(LoginOk {
            token: String::new(), uid: String::new(), account: account.to_string(),
            needs_verify: true,
            tfa_key: res.get("tfaKey").and_then(|v| v.as_str()).unwrap_or_default().to_string(),
        });
    }
    let token = res.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if token.is_empty() {
        return Err("auth.errNoToken".into());
    }
    let uid = res.get("uid").map(|v| v.to_string().trim_matches('"').to_string())
        .or_else(|| decode_uid_from_token(&token))
        .unwrap_or_default();
    Ok(LoginOk { token, uid, account: account.to_string(), needs_verify: false, tfa_key: String::new() })
}

pub async fn login_with_code(region: &str, account: &str, code: &str) -> Result<LoginOk, String> {
    if account.is_empty() || code.is_empty() {
        return Err("auth.errPhoneCodeRequired".into());
    }
    let res = request(
        api_host(region), LOGIN_PATH, reqwest::Method::POST,
        Some(json!({ "account": account, "code": code })), None,
    ).await?;
    let token = res.get("accessToken").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if token.is_empty() {
        return Err(match res.get("code").and_then(|c| c.as_i64()) {
            Some(1) => "auth.errCodeExpired".to_string(),
            Some(2) => "auth.errCodeWrong".to_string(),
            _ => res.get("error").or_else(|| res.get("message"))
                .and_then(|v| v.as_str()).unwrap_or("auth.errLoginRetry").to_string(),
        });
    }
    let uid = res.get("uid").map(|v| v.to_string().trim_matches('"').to_string())
        .or_else(|| decode_uid_from_token(&token))
        .unwrap_or_default();
    Ok(LoginOk { token, uid, account: account.to_string(), needs_verify: false, tfa_key: String::new() })
}

pub async fn request_sms_code(phone: &str) -> Result<(), String> {
    if phone.is_empty() {
        return Err("settings.errPhoneRequired".into());
    }
    match request(
        SMS_CODE_HOST, SMS_CODE_PATH, reqwest::Method::POST,
        Some(json!({ "phone": phone, "type": "codeLogin" })), None,
    ).await {
        Ok(_) => Ok(()),
        Err(e) if e.contains("HTTP 429") => Err("auth.errSmsTooMany".into()),
        Err(e) if e.contains("HTTP 403") => Err("auth.errSmsBlocked".into()),
        Err(e) if e.contains("HTTP 400") => Err("auth.errSmsBadPhone".into()),
        Err(e) => Err(e),
    }
}

/// 取数字 uid（MQTT 用户名 u_<uid> 需要）。中国区 token 不透明，必须走接口。
pub async fn get_uid(region: &str, token: &str) -> Result<String, String> {
    let res = request(api_host(region), PREFERENCE_PATH, reqwest::Method::GET, None, Some(token)).await?;
    res.get("uid")
        .map(|v| v.to_string().trim_matches('"').to_string())
        .ok_or_else(|| "auth.errUidMissing".into())
}

pub async fn list_devices(region: &str, token: &str) -> Result<Vec<Value>, String> {
    let res = request(api_host(region), DEVICE_LIST_PATH, reqwest::Method::GET, None, Some(token)).await?;
    let list = res.get("devices").and_then(|d| d.as_array()).cloned().unwrap_or_default();
    let mut out = Vec::new();
    for d in list {
        let serial = d.get("dev_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if serial.is_empty() { continue; }
        out.push(json!({
            "serial": serial,
            "name": d.get("name").and_then(|v| v.as_str()).unwrap_or(&serial),
            // 优先对外产品名（X2D/P2S），而非内部型号代号（N6-V2）
            "model": d.get("dev_product_name").and_then(|v| v.as_str())
                .or_else(|| d.get("dev_model_name").and_then(|v| v.as_str()))
                .unwrap_or(""),
            "online": d.get("online").and_then(|v| v.as_bool()).unwrap_or(false),
        }));
    }
    Ok(out)
}
