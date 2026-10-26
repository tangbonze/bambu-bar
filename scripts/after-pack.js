#!/usr/bin/env node
/**
 * electron-builder `afterPack` 钩子（模块形式）。
 *
 * 钩子在打包完成、生成 DMG 之前执行，所以 DMG 里打进去的是已签名的 app。
 *
 * 为什么要签名：没有 Developer ID 证书时 electron-builder 会跳过签名，
 * 而 Electron 自带的二进制只有 linker 阶段的 ad-hoc 签名
 * （`CodeDirectory flags=adhoc,linker-signed`、`Sealed Resources=none`）。
 * 这种签名与打包进去的资源不匹配，`codesign --verify` 会报
 * "code has no resources but signature indicates they must be present"，
 * 双击时 macOS 也可能判成「已损坏」。重新签一遍即可自洽。
 *
 * 注意：仅 ad-hoc 签名，未做 Apple 公证（notarize）。
 * 分发给他人时对方仍需在「系统设置 → 隐私与安全性」里手动放行。
 */
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** @param {{ appOutDir: string, packager: { appInfo: { productFilename?: string, productName?: string } } }} context */
module.exports = async function afterPack(context) {
  const filename = context?.packager?.appInfo?.productFilename || 'Bambu Bar';
  const target = path.join(context.appOutDir, `${filename}.app`);

  if (!fs.existsSync(target)) {
    throw new Error(`afterPack: 找不到应用包 ${target}`);
  }

  console.log(`  • afterPack: ad-hoc 签名 ${path.basename(target)}`);

  const run = (cmd, args) =>
    execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    run('codesign', ['--force', '--deep', '--sign', '-', target]);
    run('codesign', ['--verify', '--deep', '--strict', target]);
  } catch (err) {
    throw new Error(
      `afterPack: 签名失败：${(err.stderr || err.message).toString().trim()}`
    );
  }

  // 去掉可能残留的隔离属性，避免首次打开被 Gatekeeper 拦
  try {
    run('xattr', ['-cr', target]);
  } catch {
    /* 没有隔离属性时 xattr 会以非零码退出，忽略 */
  }

  const dv = spawnSync('codesign', ['-d', '--verbose=2', target], { encoding: 'utf8' });
  const summary = `${dv.stdout || ''}${dv.stderr || ''}`;
  const idLine = summary.split('\n').find((l) => l.startsWith('Identifier=')) || '';
  console.log(`  • afterPack: ${idLine.trim() || '已签名'}`);
};
