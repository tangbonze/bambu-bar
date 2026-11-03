#!/usr/bin/env bash
# 用 hdiutil 直接出一个「拖进去」的 DMG。
#
# 为什么不用 `tauri build` 自带的 dmg 目标：它的 bundle_dmg.sh 会通过 AppleScript 让
# Finder 摆窗口位置，在没有「自动化」授权、或者 macOS 新版上，这一步会直接失败，
# 连带把已经打好的 .app 也一起判成打包失败（错误信息只有一行 hdiutil 的废弃警告，极具误导性）。
# 这里的做法不碰 Finder：把 .app 和 /Applications 软链放进暂存目录，压成只读镜像。

set -euo pipefail

cd "$(dirname "$0")/.."

# 交叉编译时产物在 target/<triple>/release/...，本机构建在 target/release/...，
# 两种都认。找不到就报错退出。
find_app() {
  local candidate
  for candidate in \
    src-tauri/target/release/bundle/macos/Bambu\ Bar.app \
    src-tauri/target/*/release/bundle/macos/Bambu\ Bar.app
  do
    [ -d "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

APP=$(find_app) || {
  echo "找不到 Bambu Bar.app（target/release 与 target/*/release 下都搜过了），先跑 npx tauri build" >&2
  exit 1
}

# 签名兜底：tauri.conf.json 里配了 signingIdentity="-"，正常情况下 tauri build 已经把整个
# bundle 签好（Contents/_CodeSignature/CodeResources 存在）。但交叉编译那条路（CI 的
# x64 job 在 arm64 主机上编 x86_64）不一定走到那一步，一旦漏掉，bundle 就只有 Mach-O 上
# 链接器自动加的 linker-signed 签名、没有资源封印——从浏览器下载后 Gatekeeper 会直接报
# 「应用已损坏」，而不是通常的「无法验证开发者」。
#
# 详见 scripts/sign-app.sh 里的说明。
./scripts/sign-app.sh "$APP"

# 版本从 .app 自己的 Info.plist 读，不猜。
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "${APP}/Contents/Info.plist" 2>/dev/null || echo "0.1.0")

# 架构跟着产物路径走，别用 uname -m：在 arm64 主机上交叉编译 x86_64 时
# uname -m 仍然是 arm64，DMG 名字会骗人。
ARCH=$(uname -m)
case "$APP" in
  *aarch64-apple-darwin*) ARCH=arm64 ;;
  *x86_64-apple-darwin*)  ARCH=x64 ;;
esac

# DMG 放在 .app 同级的 bundle/dmg 里，CI 的 artifact glob 正好能捞到。
OUT=$(dirname "$APP")/../dmg
OUT=$(cd "$(dirname "$OUT")" && pwd)/$(basename "$OUT")
DMG="${OUT}/Bambu Bar_${VERSION}_${ARCH}.dmg"

STAGE=$(mktemp -d)
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"

mkdir -p "$OUT"
rm -f "$DMG"

# -quiet 会吞掉「已创建」以外的输出；hdiutil 在 macOS 27 上会打一条废弃警告，
# 那是噪音——命令本身仍然正常（已验证挂载/卸载往返可用）。
hdiutil create -quiet -volname "Bambu Bar" -srcfolder "$STAGE" -ov -format UDZO "$DMG" 2>/dev/null

SIZE=$(du -h "$DMG" | awk '{print $1}')
echo "DMG: $DMG ($SIZE)"
