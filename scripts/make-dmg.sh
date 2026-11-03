#!/usr/bin/env bash
# 用 hdiutil 直接出一个「拖进去」的 DMG。
#
# 为什么不用 `tauri build` 自带的 dmg 目标：它的 bundle_dmg.sh 会通过 AppleScript 让
# Finder 摆窗口位置，在没有「自动化」授权、或者 macOS 新版上，这一步会直接失败，
# 连带把已经打好的 .app 也一起判成打包失败（错误信息只有一行 hdiutil 的废弃警告，极具误导性）。
# 这里的做法不碰 Finder：把 .app 和 /Applications 软链放进暂存目录，压成只读镜像。

set -euo pipefail

cd "$(dirname "$0")/.."

APP="src-tauri/target/release/bundle/macos/Bambu Bar.app"
VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null || echo "0.1.0")
OUT="src-tauri/target/release/bundle/dmg"
DMG="$OUT/Bambu Bar_${VERSION}_$(uname -m).dmg"

[ -d "$APP" ] || { echo "找不到 $APP，先跑 npx tauri build" >&2; exit 1; }

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
