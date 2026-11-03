#!/usr/bin/env bash
# 给 .app 做 ad-hoc 签名，并验证签名真的有效。
#
# 为什么必须做：不签（或只签 Mach-O）的话，从浏览器下载后 macOS 的 Gatekeeper
# 会直接报「应用已损坏、无法打开」——因为 bundle 没有资源封印
# （Contents/_CodeSignature/CodeResources 不存在），Gatekeeper 校验资源时对不上。
# 官方原话：code signing is required on macOS "to prevent a warning that your
# application is broken and can not be started, when downloaded from the browser"。
#
# 没有 Apple 开发者证书时，ad-hoc（`--sign -`）是唯一能用的身份：
# 它把整个 bundle 签好（资源被封印进 CodeResources），让 Gatekeeper 的提示从
# 「已损坏」变成正常的「无法验证开发者」——后者是可以点「仍要打开」放行的。
# 但 ad-hoc 不等于公证（notarized），首次启动仍需要用户手动放行一次。
#
# 用法：./scripts/sign-app.sh [path/to/Bambu Bar.app]
#        不给路径就在 target/release 与 target/*/release 下找。

set -euo pipefail

cd "$(dirname "$0")/.."

find_app() {
  local candidate
  for candidate in \
    "src-tauri/target/release/bundle/macos/Bambu Bar.app" \
    src-tauri/target/*/release/bundle/macos/Bambu\ Bar.app
  do
    [ -d "$candidate" ] && { echo "$candidate"; return 0; }
  done
  return 1
}

if [ $# -ge 1 ]; then
  APP="$1"
else
  APP=$(find_app) || {
    echo "找不到 Bambu Bar.app（target/release 与 target/*/release 下都搜过了），先跑 npx tauri build" >&2
    exit 1
  }
fi

[ -d "$APP" ] || {
  echo "不是目录：$APP" >&2
  exit 1
}

# --force 覆盖已有签名，--deep 递归处理嵌套代码，--sign - 是 ad-hoc。
# codesign 对已正确签名的 bundle 是幂等的，多跑一次没有副作用。
if ! codesign --force --deep --sign - "$APP" 2>/dev/null; then
  echo "签名失败：$APP 仍是未签名状态，打出来的包装上会报「已损坏」" >&2
  exit 1
fi

# 签完必须再验一次：codesign --verify --strict 过了才说明资源封印与 Mach-O 一致。
# 少了 _CodeSignature/ 或资源对不上，这一步会报 "code has no resources but signature
# indicates they must be present"，退出码非 0。
if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
  echo "签名校验失败：$APP（codesign --verify --deep --strict 未通过）" >&2
  exit 1
fi

echo "签名: ad-hoc（bundle 已封印，verify --deep --strict 通过）"
