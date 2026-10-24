// qq-notify — hook 入口：维护稳定运行目录 + 注册计划任务
// ═══════════════════════════════════════════════════════════════════
// 职责（仅此三件，任何失败都静默退出 0，绝不阻塞会话）：
//   1. 把 watchdog.mjs / zcode-adapter.mjs / run-hidden.vbs 的最新副本
//      同步到 ~/.qq-notify/（版本无关的稳定目录，计划任务只指向这里，
//      插件更新换缓存路径、ZCode 重装都不影响）
//   2. 用插件 config.json 的设置引导 ~/.qq-notify.json（只补缺失键，
//      永不覆盖用户已改的值——该文件是运行时的唯一配置来源）
//   3. 注册/校正 Windows 计划任务（每分钟一次单次巡检）
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STABLE = path.join(os.homedir(), '.qq-notify');
const TASK_NAME = 'qq-notify-watchdog';

function sha256(p) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; }
}

function maintainStableDir() {
  const files = ['watchdog.mjs', 'zcode-adapter.mjs', 'run-hidden.vbs'];
  fs.mkdirSync(STABLE, { recursive: true });
  for (const f of files) {
    const src = path.join(SCRIPT_DIR, f);
    const dst = path.join(STABLE, f);
    const h = sha256(src);
    if (h && h !== sha256(dst)) fs.copyFileSync(src, dst);
  }
}

function bootstrapConfig() {
  let pc = {};
  try { pc = JSON.parse(fs.readFileSync(path.join(SCRIPT_DIR, '..', 'config.json'), 'utf8')); } catch { /* 无插件配置 */ }
  const up = path.join(os.homedir(), '.qq-notify.json');
  let uc = {};
  try { uc = JSON.parse(fs.readFileSync(up, 'utf8')); } catch { /* 首次 */ }
  let dirty = false;
  for (const k of ['qmsgKey', 'thresholdSeconds', 'stallMinutes', 'inFlightCapMinutes']) {
    if (uc[k] === undefined && pc[k] !== undefined && pc[k] !== '') { uc[k] = pc[k]; dirty = true; }
  }
  if (dirty) fs.writeFileSync(up, JSON.stringify(uc, null, 2));
}

function ensureTask() {
  const root = path.join(os.tmpdir(), 'qq-notify-watchdog');
  fs.mkdirSync(root, { recursive: true });
  const vbs = path.join(STABLE, 'run-hidden.vbs');
  const tr = `wscript.exe "${vbs}"`; // vbs 自定位同目录的 watchdog.mjs，无需传参
  const marker = path.join(root, 'task-marker.json');
  const want = JSON.stringify({ tr, day: new Date().toISOString().slice(0, 10) });
  let cur = '';
  try { cur = fs.readFileSync(marker, 'utf8'); } catch { /* 首次 */ }
  if (cur === want) return; // 今天已校验且任务指向无变化
  execSync(`schtasks /Create /F /SC MINUTE /MO 1 /TN "${TASK_NAME}" /TR "${tr}"`, {
    timeout: 15000, windowsHide: true, stdio: 'ignore',
  });
  fs.writeFileSync(marker, want);
  console.error('qq-notify: 计划任务已注册/校正（稳定目录）');
}

async function main() {
  try { for await (const c of process.stdin) void c; } catch { /* stdin 可能为空 */ }
  try {
    maintainStableDir();
    bootstrapConfig();
    ensureTask();
  } catch (e) {
    console.error(`qq-notify: hook 维护失败 ${e?.message || e}`);
  }
}

main().catch(() => process.exit(0));
