// qq-notify — ZCode 任务通知插件（Qmsg 酱通道）
// 本 hook 只负责一件事：确保看门狗计划任务已注册（自愈式，路径变化自动重建）。
// 通知本体由 watchdog.mjs 驱动——以 ZCode 运行日志 + 会话数据库为源，计划任务
// 每分钟巡检一次，与 hook 的会话绑定无关：老对话、SSH 对话、后台任务子会话一律覆盖。
// 任何失败都静默退出 0，绝不阻塞会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));

// 看门狗由 Windows 计划任务驱动（每分钟单次巡检，其进程在 ZCode 的作业对象之外，
// 不会被会话结束殃及）。这里只负责注册/自愈：路径变化或每日首次触发时校验重建。
function ensureTask() {
  try {
    const root = path.join(os.tmpdir(), 'qq-notify-watchdog');
    fs.mkdirSync(root, { recursive: true });
    const marker = path.join(root, 'task-marker.json');
    const want = JSON.stringify({ dir: SCRIPT_DIR, day: new Date().toISOString().slice(0, 10) });
    let cur = '';
    try { cur = fs.readFileSync(marker, 'utf8'); } catch { /* 首次 */ }
    if (cur === want) return; // 今天已校验过
    const tn = 'qq-notify-watchdog';
    let exists = true;
    try {
      execSync(`schtasks /Query /TN "${tn}"`, { timeout: 10000, windowsHide: true, stdio: 'ignore' });
    } catch { exists = false; }
    if (!exists) {
      const vbs = path.join(SCRIPT_DIR, 'run-hidden.vbs');
      const wd = path.join(SCRIPT_DIR, 'watchdog.mjs');
      execSync(`schtasks /Create /F /SC MINUTE /MO 1 /TN "${tn}" /TR "wscript.exe ${vbs} ${wd}"`, {
        timeout: 15000, windowsHide: true, stdio: 'ignore',
      });
      console.error('qq-notify: 看门狗计划任务已注册');
    }
    fs.writeFileSync(marker, want);
  } catch (e) {
    console.error(`qq-notify: 看门狗计划任务注册失败 ${e?.message || e}`);
  }
}

async function main() {
  try { for await (const c of process.stdin) void c; } catch { /* stdin 可能为空 */ }
  ensureTask();
}

main().catch(() => process.exit(0));
