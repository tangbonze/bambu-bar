# Bambu Bar

拓竹（Bambu Lab）打印机的菜单栏 / 托盘监控面板，Tauri 2 实现，支持 macOS / Windows / Linux。

从 v1.0.4 起，本仓库的主线就是这份 Tauri 实现；Electron 的**平台层**（主进程、preload、旧的双页面前端）
留在 `v1.0.3` 标签与历史记录里。两者是**同源实现**：视图模型与状态机逻辑仍是原来那份经过真机校准的 JS
（就在本仓库 `src/` 下，打包进 WebView），换成 Rust 的只有传输层（MQTT、鉴权）与平台能力（托盘、窗口）。
所以两个版本的状态判断、耗材解析、完工时刻推算**一定一致**——不存在「新版把某台机认成失败」这种漂移。

---

## 实测数据

同一台机器（Apple Silicon）、同一份演示数据、都在空闲 12 秒后取样：

| 版本 | 常驻物理足迹 | 说明 |
| :--- | ---: | :--- |
| Electron 38（旧） | **257.5 MB** | 主进程 74.5 + GPU 107.0 + 网络 7.1 + 渲染 68.9 |
| Tauri 2（本版） | **72.9 MB** | 主进程 38.0 + WebContent 28.2 + Networking 6.7 |
| Tauri 2（面板打开、真实数据） | **约 78 MB** | 主进程 36.8 + WebContent 41.5 |

- 数据取自 `vmmap -summary` 的 `Physical footprint`，不是 `ps` 的 RSS（RSS 会把共享框架页重复计入）。
- 空闲 CPU 0.0%（1 秒节拍的托盘刷新 + MQTT 收包）。
- 真实账号实测：3 台设备（2 台打印中）轮播正常，云端 MQTT 首帧在启动后 2 秒内到达。
- 单文件可执行 11.9 MB、`.app` 11 MB、`.dmg` 3.3 MB；Electron 版 DMG 约 90 MB。
- 关掉 `--panel` 的窗口不进前台时，WebContent 那 28 MB 也不会被创建（窗口是懒显示的）。

---

## 跨平台：托盘能力是不对等的，这是 OS 限制

| 能力 | macOS | Windows | Linux |
| :--- | :--- | :--- | :--- |
| 托盘文字标题 | ✅ `NSStatusItem.setTitle` | ❌ 只有图标 + tooltip | ❌ 只有图标 + tooltip |
| 模板图标（跟随明暗反色） | ✅ | ❌ 需自备深浅两套 | ❌ 同左 |
| 悬浮面板定位 | ✅ 读托盘矩形 | ✅ | ⚠️ Wayland 下位置受限 |

所以 `tray.rs` 对外只暴露一个 `update(app, state)`，内部两条实现：

```
macOS     →  文字标题「 X1C 42%」（像素级定宽）+ 模板图标
Win/Linux →  32×32 动态位图（状态色进度环 + 中心点）+ tooltip
```

Windows / Linux 的图标是 Rust 侧用 `tiny-skia` 现画的（`render_badge`），不依赖任何图像库或运行时资源。


```
tray.rs 单测：
  advance_table_matches_appkit_sample  逐字累加 == AppKit 实测 62.68px（误差 <0.05px）
  entry_text_has_no_padding_of_its_own  entry_text 只产出干净文字（补白只在 pad_centered 里加）
  padding_is_split_evenly_...          左右补白差 ≤1px、总宽落在目标宽度 ±1px
  percent_slot_is_right_aligned        1% / 42% / 100% 的「%」严格对齐
  width_tracks_content_not_a_fixed_120 A1 这类短机型宽度上限 < 70px
  slot_width_is_constant_...           轮播集里每帧补到的总宽度一致
  no_state_mark_in_menu_bar            任何状态都不带 ‖ / … 前缀
  eta_crosses_midnight                 跨天完工带 +1 后缀
  lan::serial_is_found...              SSDP 回复里按 15 位特征找序列号
```

运行时验证（`BAMBU_BAR_DEBUG_TRAY=1`）：

```
[tray] idx=0 target=60.04 width=59.50 rect=Some((617.0, 0.0, 100.0, 30.0)) text="\u{200a}\u{200a}P1S  79%\u{200a}"
```

同一轮播集里 `target` 恒定 → 宽度不跳；补白左右各半 → 文字居中。
无障碍接口（`AXExtrasMenuBar`）读回：`title="  P1S  79% " size=(102, 24)`——没有 `‖`。
截图逐列取墨迹：图标 564.5…576.0pt、文字 585.0…639.5pt，`P`/`1`/`S`/`7`/`9`/`%` 六个字符各自成段。

---

## 两条通道：云端 + 局域网直连

| 通道 | 鉴权 | 依赖 | 适用 |
| :--- | :--- | :--- | :--- |
| 云端 MQTT | 登录令牌（uid + token） | 拓竹服务器、外网 | 出门在外、跨网查看 |
| 局域网直连 | 访问码（用户名固定 `bblp`） | 打印机 8883 端口 | 断外网、低延迟、不想登录 |

两条通道互相独立，同一台机器可以同时挂上：报文都是 `{"print": {...}}` 的增量 diff，
合并逻辑复用同一份 `mqtt::merge_payload`（深合并、取消标记、舱门 bit），谁先到用谁的。
单条通道断掉不会立刻把设备判成离线——`set_offline_if_stale` 要「确实 90 秒没报文」才转离线，
否则另一条通道可能一秒前刚送过数据。

局域网的三个实现要点：

1. **证书必须跳过校验**：打印机是自签证书、主机名还是它自己的 IP，校验链没有意义，
   真正的鉴权是 MQTT 的 `bblp` + 访问码。`lan.rs` 里手写了一个 rustls `ServerCertVerifier`，
   签名算法仍走 rustls 自己的实现（不手写密码学）。rumqttc 的 `Native` 后端做不到这件事，
   所以打开了 `use-rustls` 特性并直接注入 `ClientConfig`。
2. **添加前先试连**：`lan_probe` 只等 CONNACK，8 秒超时。访问码错、没开局域网模式、
   不在同一网段，三种情况分别给不同的中文提示——不通过就不写配置，
   免得菜单栏里多一台永远连不上的机器。
3. **SSDP 发现**：向 `239.255.255.250:1990` 发 M-SEARCH，回复里带机型/名称/序列号。
   不同固件的字段名不一致，序列号干脆不认字段名，直接按「15 位大写字母数字」特征找。

用法：打印机屏幕 → 设置 → 网络 → 局域网模式（打开后能看到访问码），
然后在设置窗「局域网直连」里点「扫描局域网」→ 选一台 → 填 8 位访问码 → 添加。

> 注意：开启局域网模式后，这台打印机的云端连接会被打印机自己断开（拓竹的设定）。
> 想两边都要，就在 Bambu Studio / 手机端保持云端登录，本应用两条通道都配上。

---

## 目录结构

```
bambu-bar/
├── src/                     ★ 纯逻辑核心（与 Electron 版同一份文件，被 esbuild 打进 WebView）
│   ├── core/                状态机、视图模型、AMS 取色、完成记忆、错误码查询
│   ├── config/              状态名/文案/本地化表
│   └── dev/demo-data.js     演示数据
├── test/printer-view.test.js  node:test 单测（19 条）：报文 → 视图这一层不靠肉眼验证
├── ui/                     前端 = Electron 版的 HTML/CSS/JS + 一层 Tauri 适配
│   ├── index.html          面板
│   ├── settings.html       设置窗（登录 / 设备 / 局域网直连 / 显示偏好）
│   ├── settings.js         设置窗逻辑：两种登录方式、二次验证、倒计时、局域网增删
│   ├── style.css           与 Electron 版逐字节相同
│   ├── popover.js          与 Electron 版逐字节相同（只认 window.bambu）
│   ├── shim.js             ★ window.bambu 的 Tauri 实现（IIFE 隔离）
│   ├── actions.js          面板按钮接线（刷新 / 设置 / 退出）
│   ├── core-entry.js       打包入口：把 src/ 的纯逻辑核心汇出为 window.BambuCore
│   └── core.bundle.js      esbuild 产物（npm run build:ui 生成，不入库）
└── src-tauri/
    ├── src/tray.rs         托盘展示层（定宽轮播 / 对称补白 / 动态图标 / ETA）
    ├── src/windows.rs      面板与设置窗的创建、贴托盘定位、失焦收起
    ├── src/mqtt.rs         云 MQTT：深合并、pushall、取消标记、舱门 bit
    ├── src/lan.rs          局域网直连：bblp + 访问码、自签证书、SSDP 发现、试连
    ├── src/auth.rs         拓竹云鉴权（登录 / 短信 / 设备列表 / uid）
    ├── src/state.rs        运行时状态 + TrayItem 粗分类
    ├── src/commands.rs     前端 IPC
    ├── src/config.rs       配置持久化（0600）
    └── src/demo.rs         演示数据（菜单栏侧）
```

### 为什么视图模型留在 JS

`resolveState` / `buildPrinterView` 里堆的是**真机校准出来的字段兼容逻辑**：新旧固件温度打包方式不同、
AMS 深合并后「空槽」和「没插料」是两种语义、双喷头取色、跨天 ETA、完成记忆。重写成 Rust 只会多出
一份可能漂移的实现。传输层才是需要换语言的部分（Electron 的网络栈换成了 rustls + rumqttc）。

这些 JS 现已随仓库一起维护，`npm test` 会先跑那 19 条视图单测、再跑 Rust 单测——视图逻辑改坏了在 CI 就红。

---

## 开发

```bash
npm install            # esbuild（打包 JS）+ @tauri-apps/cli
npm run build:ui       # 打包 ui/core.bundle.js（tauri build 前会自动跑）
npm run dev            # npx tauri dev
npm test               # 19 条视图单测 + 10 条 Rust 单测
```

调试开关：

```bash
BAMBU_BAR_DEBUG_TRAY=1 ./target/release/bambu-bar   # 打印托盘每次写入的标题与像素宽度
./target/release/bambu-bar --panel                  # 启动即弹出面板（截图/调试用）
```

演示模式：设置窗勾选「演示模式」，或直接改配置 `demo_mode: true`。
配置文件位置（与 Electron 版字段兼容，可直接拷过来）：

- macOS `~/Library/Application Support/com.bambubar.menubar/config.json`
- Windows `%APPDATA%\com.bambubar.menubar\config.json`
- Linux `~/.config/com.bambubar.menubar/config.json`

---

## 打包

```bash
npm run build        # 只出 .app（bundle.targets = ["app"]）
./scripts/make-dmg.sh  # 再压出 .dmg
```

### 两处与默认流程不同的地方

1. **不用 tauri 自带的 dmg 目标**。它的 `bundle_dmg.sh` 会通过 AppleScript 让 Finder 摆图标位置，
   在没有「自动化」授权、或 macOS 新版上这一步直接失败，而且会把**已经打好的 .app 一起判成打包失败**，
   报错只有一行 hdiutil 的废弃警告，极具误导性。`scripts/make-dmg.sh` 不碰 Finder：
   把 `.app` 和 `/Applications` 软链放进暂存目录，`hdiutil` 压成只读镜像，实测挂载/运行正常。
2. **release 用 thin LTO**（`lto = "thin"`、`codegen-units = 4`）。全量 LTO + `codegen-units = 1`
   的链接阶段要吃掉数 GB 内存、十几分钟，在内存受限的环境里会直接被 SIGKILL（exit 137）。
   thin LTO 的产物体积只多约 2.6 MB，但构建时间从 12 分 40 秒降到 5 分 52 秒，且可稳定复现。

| 平台 | 产物 | 依赖 |
| :--- | :--- | :--- |
| macOS | `.app` + `.dmg`（脚本生成） | 10.15+，Apple Silicon 与 Intel 均可 |
| Windows | `.msi` / `.exe` | WebView2（Win10 1803+ 与 Win11 自带） |
| Linux | `.AppImage` / `.deb` | `libwebkit2gtk-4.1`、`libayatana-appindicator3` |

Linux 两条注意事项：

1. **Wayland** 下全局窗口定位不可用，面板靠托盘矩形定位；GNOME 需要装 AppIndicator 扩展才看得到图标。
2. `.deb` 的 `depends` 已在 `tauri.conf.json` 里声明，`.AppImage` 打包机需要装 `libfuse2`。

---

## CI

`.github/workflows/build.yml` 在 **Actions** 页手动触发，或推 `v*` 标签时自动跑。
四个矩阵并行：

| Job | Runner | 产物 |
| :--- | :--- | :--- |
| macos-arm64 | macos-14 | `.app` + `.dmg`（`aarch64-apple-darwin`） |
| macos-x64 | macos-14 | `.app` + `.dmg`（`x86_64-apple-darwin`，交叉编译） |
| windows | windows-latest | `.exe`（NSIS） |
| linux | ubuntu-22.04 | `.AppImage` + `.deb` |

打包前会先跑 **19 条 JS 视图单测 + 11 条 Rust 单测**，两套都绿了才出包。
Linux job 额外装 WebKitGTK 与 AppIndicator——缺这两个库能编过，但运行起来既没图标也没界面。

<details>
<summary>踩过的坑（改 CI 前先看一眼）</summary>

- **Node 版本**：`node --test "test/*.test.js"` 这种带引号的 glob 写法，Node 20 不认
  （会当成字面路径去找，报 `Could not find '.../test/*.test.js'`），Node 22 才原生支持。
  CI 里必须用 Node 22。
- **`macos-13` runner 已下线**，x64 改到 macos-14 交叉编译。因为两个 macOS job 都是 arm64 主机，
  Rust target 由 matrix 显式给出（`matrix.rust`），不再按 `matrix.os` 猜。
- **`tauri-action` 调的是 `npm run tauri build -- <args>`**，所以 `package.json` 里必须有
  `"tauri": "tauri"` 这个脚本，否则报 `Missing script: "tauri"`。
- **Windows 需要 `icons/icon.ico`**。仓库里原本只有 macOS 用的 png + icns，
  现在用 `npx tauri icon` 从 1024×1024 源图生成了全套（android/ios 目录用不到，已删）。
  注意 `tauri icon` 会把源 `icon.png` 改写成 512×512，macOS 图标清晰度会掉——
  源图和 `icon.icns` 单独还原回原样，只提交新增的变体。
- **bash 在 UTF-8 locale 下会把变量名后面的中文标点算进变量名**：
  `echo "找不到 $APP，先跑"` 里的中文逗号会被当成变量名的一部分，
  报 `APP?: unbound variable`。本机 locale 不是 UTF-8 时怎么跑都正常，只有 CI 炸。
  shell 脚本里变量后紧跟非 ASCII 标点，一律写 `${APP}`。

</details>

---

## 与 Electron 版的取舍

设置窗的登录是重新设计的：先选「服务器区域」和「登录方式」，再填**一张表**。
早期版本把「登录」「发送短信验证码」「刷新设备」并排放在一行、验证码行还要点出来，
用户不知道先点哪个——这是被明确反馈过的问题。
现在邮箱二次验证会直接接管这张表（收起密码登录按钮、锁住账号与区域、只剩「完成登录」和「换个账号重新登录」），
登录成功后提示「已同步 N 台打印机」——因为两条验证码路径都会在登录后立刻拉设备清单，
不会再出现「提示登录成功但设备列表空着、要手动点刷新」。

保留：面板视觉、状态语义、AMS 图谱、轮播节奏、配置格式。
放弃：系统钥匙串（Electron 用 `safeStorage`，这里 token 以 0600 权限明文存盘——跨平台钥匙串要三套后端，
留到后续版本）。

### 已知差异（还没补上的）

Electron 版在登录后会额外拉一份服务器下发的 HMS 错误码表，把失败状态翻译成中文说明
（面板上「HMS 8A00...」下面那行小字）。Tauri 版这一层还没接：`shim.js` 组装视图时没有传
`reason`，所以失败卡片只显示 HMS 码本身、没有说明文字。码还在、能搜，只是少了一行中文。
补齐需要在 Rust 侧加一次「登录后取错误码表」的请求，放到下一个版本。

---

## 更新记录

### 1.0.4

接在 `v1.0.3` 之后的版本：这一版把应用整体换成 Tauri 2（Electron 的平台层源码留在 `v1.0.3` 标签与历史里，
`src/` 下的纯逻辑核心随主线继续维护）。

- **新增局域网直连**：`bblp` + 访问码直连 8883，不依赖拓竹服务器；带 SSDP 扫描、
  添加前试连、访问码错误的中文提示。云端与局域网可同时挂在一台机器上。
- **修复菜单栏状态不居中**：改为「左右对称补白」——先把轮播集里最宽那条的宽度定为目标，
  再把差额对半分到文字两侧。宽度依然恒定（轮播时右边的系统时钟不跳），文字落在条目正中。
  （中途试过 `NSStatusItem.setLength` 钉死宽度让 AppKit 自己居中，实测条目窗口会被挪出菜单栏，已回退，见上文。）
- 连接健康判定改为「90 秒无报文才判离线」，避免两条通道互相打断。
- 设置窗新增「局域网直连」卡片；窗口尺寸 580×840。
- 菜单栏去掉状态符号：暂停不再挂 `‖`、准备/换料不再挂 `…`，只留「机型 + 进度」。
- 仓库主线里的 JS 核心带上了原来的 19 条视图单测，`npm test` 会连同 Rust 单测一起跑。
- **接上 GitHub Actions**：四平台并行构建（macOS arm64/x64、Windows NSIS、Linux AppImage+deb），
  打包前先跑两套单测。release 里的三个安装包（macOS 双架构 DMG、Windows 安装包）都来自 CI 产物。
