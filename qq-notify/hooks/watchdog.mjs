// qq-notify 看门狗 — 检测中断回合并发送"⚠️ 任务中断"通知
// 由 UserPromptSubmit hook 以 detached 方式拉起（幂等，已在运行则直接退出）：
//   - 每 30 秒扫描回合状态，跟踪各会话记录文件的更新时间
//   - 状态残留且会话记录停更达到失联阈值 → 报警（每个回合最多一次）
//   - ZCode 已关闭时不报警（回头补报）；15 分钟无未决回合自动退出
// 环境变量:
//   QQ_NOTIFY_STALL_MINUTES      失联阈值（分钟），优先级最高，默认取 config.stallMinutes 或 5
//   QQ_NOTIFY_WATCHDOG_POLL_MS   轮询间隔（测试用）
//   QQ_NOTIFY_STATE_DIR          状态目录覆盖（测试用）
//   QMSG_KEY / QQ_NOTIFY_DRY_RUN 同 notify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.QQ_NOTIFY_STATE_DIR || path.join(os.tmpdir(), 'qq-notify-state');
const ROOT = path.join(os.tmpdir(), 'qq-notify-watchdog');
const LOCK = path.join(ROOT, 'daemon.lock');
const MEM_FILE = path.join(ROOT, 'memory.json');
const POLL_MS = Math.max(2000, Number(process.env.QQ_NOTIFY_WATCHDOG_POLL_MS) || 30000);
const IDLE_EXIT_MS = 15 * 60 * 1000;

function loadConfig() {
  const root = process.env.ZCODE_PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT;
  const candidates = [
    root && path.join(root, 'config.json'),
    path.join(SCRIPT_DIR, '..', 'config.json'),
  ].filter(Boolean);
  for (const p of candidates) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 尝试下一个 */ }
  }
  return {};
}

function stallMs() {
  const envV = Number(process.env.QQ_NOTIFY_STALL_MINUTES);
  if (Number.isFinite(envV) && envV > 0) return envV * 60000;
  const cfgV = Number(loadConfig().stallMinutes);
  if (Number.isFinite(cfgV) && cfgV > 0) return cfgV * 60000;
  return 5 * 60000;
}

function projectName() {
  const dir = process.env.ZCODE_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  return path.basename(dir) || '未知项目';
}

function formatDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}小时${m}分`;
  if (m > 0) return `${m}分${r}秒`;
  return `${r}秒`;
}

function zcodeRunning() {
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq ZCode.exe" /NH', {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
    });
    return out.toUpperCase().includes('ZCODE.EXE');
  } catch {
    return true; // 查询失败按运行中处理，宁可误报不可漏报
  }
}

async function send(text) {
  const key = process.env.QMSG_KEY || loadConfig().qmsgKey;
  if (!key) {
    console.error('qq-notify-watchdog: 未配置 QMSG_KEY 或 config.json 的 qmsgKey');
    return;
  }
  if (process.env.QQ_NOTIFY_DRY_RUN === '1') {
    console.error(`qq-notify-watchdog: DRY RUN 未发送，消息内容:\n${text}`);
    return;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `https://qmsg.zendee.cn/v3/send/${key}?msg=${encodeURIComponent(text)}`,
        { signal: AbortSignal.timeout(8000) },
      );
      const body = await res.json().catch(() => ({}));
      console.error(`qq-notify-watchdog: Qmsg ${res.status} success=${body.success}`);
      if (body.success) return;
    } catch (e) {
      console.error(`qq-notify-watchdog: 发送失败 ${e?.cause?.message || e?.message || e}`);
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 6000)); // Qmsg 限流 1条/5秒
  }
}

function buildMessage(st, ranSec) {
  const lines = ['⚠️ 任务中断'];
  const proj = projectName();
  if (proj && proj !== 'default') lines.push(`项目：${proj}`);
  if (st.prompt) lines.push(`任务：${st.prompt}`);
  lines.push(`已运行：${formatDuration(ranSec)}后失联`);
  lines.push('（回合未正常结束，请回 ZCode 查看）');
  return lines.join('\n');
}

let mem = { lastSeen: {}, alerted: {} };
function saveMem() {
  try { fs.writeFileSync(MEM_FILE, JSON.stringify(mem)); } catch { /* 忽略 */ }
}

async function poll() {
  let files = [];
  try {
    files = fs.readdirSync(STATE_DIR).filter(f => f.startsWith('session-'));
  } catch { return; }

  if (files.length === 0) {
    if (Date.now() - lastActivity > IDLE_EXIT_MS) {
      console.error('qq-notify-watchdog: 无未决回合，退出');
      process.exit(0);
    }
    return;
  }

  const currentKeys = new Set();
  let anyPending = false;
  const stall = stallMs();

  for (const f of files) {
    let st;
    try { st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); } catch { continue; }
    const tp = st.transcriptPath || st.transcript_path;
    if (!tp) continue; // 拿不到会话记录路径就无法判定，宁缺勿滥
    const alertKey = `${f}:${st.turnId || ''}`;
    currentKeys.add(alertKey);
    if (mem.alerted[alertKey]) continue; // 该回合已报警

    let mtime = 0;
    try { mtime = fs.statSync(tp).mtimeMs; } catch { mtime = 0; } // 文件可能已被清理，沿用最后记录
    if (mtime > (mem.lastSeen[alertKey] || 0)) {
      mem.lastSeen[alertKey] = mtime;
      saveMem();
    }
    const seen = mem.lastSeen[alertKey] || 0;
    if (!seen) continue; // 从未观察到会话记录，无法判定
    anyPending = true;
    if (Date.now() - seen < stall) continue; // 尚未失联
    if (!zcodeRunning()) continue; // 应用已关闭：不标记不报警，应用恢复后补报

    mem.alerted[alertKey] = true;
    saveMem();
    const ranSec = st.start ? (Date.now() - st.start) / 1000 : 0;
    await send(buildMessage(st, ranSec));
  }

  // 清理已消失回合的记忆
  for (const k of Object.keys(mem.lastSeen)) {
    if (!currentKeys.has(k)) { delete mem.lastSeen[k]; delete mem.alerted[k]; }
  }
  if (anyPending) lastActivity = Date.now();
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

let lastActivity = Date.now();

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  try {
    fs.writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
  } catch {
    let pid = 0;
    try { pid = Number(fs.readFileSync(LOCK, 'utf8')); } catch { /* 当作陈旧锁 */ }
    if (pid && isAlive(pid)) process.exit(0); // 已有实例在运行
    fs.writeFileSync(LOCK, String(process.pid)); // 接管陈旧锁
  }
  try { mem = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch { /* 首次运行 */ }
  if (process.argv.includes('--once')) {
    await poll();
    saveMem();
    process.exit(0);
  }
  console.error(`qq-notify-watchdog: 运行中 (pid ${process.pid}, 轮询 ${POLL_MS}ms)`);
  setInterval(() => { poll().catch(e => console.error(`qq-notify-watchdog: ${e?.message || e}`)); }, POLL_MS);
}

main().catch(e => { console.error(`qq-notify-watchdog: ${e?.message || e}`); process.exit(0); });
