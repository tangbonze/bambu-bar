#!/usr/bin/env node
/**
 * electron-builder afterPack 钩子：给产出的 .app 做一次整包 ad-hoc 签名。
 *
 * 为什么要签名：没有 Developer ID 证书时 electron-builder 会跳过签名，
 * 而 Electron 自带的二进制只有 linker 阶段的 ad-hoc 签名
 * （`CodeDirectory flags=adhoc,linker-signed`、`Sealed Resources=none`）。
 * 这种签名与打包进去的资源不匹配，`codesign --verify` 会报
 * "code has no resources but signature indicates they must be present"，
 * 双击时 macOS 也可能判成「已损坏」。重新签一遍即可自洽。
 *
 * 在 afterPack 阶段执行，DMG 里打进去的就是已签名的 app。
 *
 * 用法：由 electron-builder 自动调用，也可手动执行
 *   node scripts/sign-adhoc.js [app 路径]
 */
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const fallback = path.join(root, 'dist', 'mac-arm64', 'Bambu Bar.app');
const target = process.argv[2] ? path.resolve(process.argv[2]) : fallback;

function run(cmd, args) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

if (!fs.existsSync(target)) {
  console.error(`✗ 找不到应用包：${target}`);
  console.error('  先执行 npm run build:mac（或单独 electron-builder --mac）。');
  process.exit(1);
}

console.log(`· ad-hoc 签名 ${path.relative(root, target)}`);

try {
  run('codesign', ['--force', '--deep', '--sign', '-', target]);
} catch (err) {
  console.error('✗ codesign 失败：', (err.stderr || err.message).toString().trim());
  process.exit(1);
}

let verified = true;
try {
  run('codesign', ['--verify', '--deep', '--strict', target]);
} catch (err) {
  verified = false;
  console.error('✗ 签名校验未通过：', (err.stderr || err.message).toString().trim());
}

// 去掉可能残留的隔离属性，避免首次打开被 Gatekeeper 拦
try {
  run('xattr', ['-cr', target]);
} catch {
  /* 没有隔离属性时 xattr 会以非零码退出，忽略 */
}

// 打印签名摘要，便于确认 Identifier 已换成 bundle id。
// codesign -d 会把摘要写到 stderr，所以用 spawnSync 同时收两个流。
const dv = spawnSync('codesign', ['-d', '--verbose=2', target], { encoding: 'utf8' });
const summary = `${dv.stdout || ''}${dv.stderr || ''}`;
const idLine = summary.split('\n').find((l) => l.startsWith('Identifier=')) || '';
const resLine = summary.split('\n').find((l) => l.startsWith('Sealed Resources')) || '';

if (verified) {
  console.log(`✓ 已签名 ${idLine.trim()}${resLine ? ' · ' + resLine.trim() : ''}`);
  console.log('  未做 Apple 公证，本机可直接运行；分发给别人仍需 Developer ID + notarize。');
} else {
  process.exit(1);
}
