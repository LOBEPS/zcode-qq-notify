// qq-notify 看门狗 — 单次巡检：检测中断回合并发送"⚠️ 任务中断"通知
// 由 Windows 计划任务每分钟调起（--once，跑完即退）——计划任务进程在 ZCode 的
// 作业对象之外，不会被会话结束殃及。状态记录在 memory.json，跨巡检累计。
// 判定：回合状态残留（走了 UserPromptSubmit 却始终没等到 Stop）+ 该会话在
// ZCode 运行日志中停止追加达到失联阈值 → 报警（每个回合最多一次）。
// ZCode 已关闭时不报警（回头补报）。
// 环境变量:
//   QQ_NOTIFY_STALL_MINUTES      失联阈值（分钟），优先级最高，默认取 config.stallMinutes 或 5
//   QQ_NOTIFY_STATE_DIR          状态目录覆盖（测试用）
//   QQ_NOTIFY_LOG_DIR            ZCode 日志目录覆盖（测试用）
//   QMSG_KEY / QQ_NOTIFY_DRY_RUN 同 notify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = process.env.QQ_NOTIFY_STATE_DIR || path.join(os.tmpdir(), 'qq-notify-state');
const LOG_DIR = process.env.QQ_NOTIFY_LOG_DIR || path.join(os.homedir(), '.zcode', 'cli', 'log');
const ROOT = path.join(os.tmpdir(), 'qq-notify-watchdog');
const MEM_FILE = path.join(ROOT, 'memory.json');
const TAIL_BYTES = 262144; // 日志尾部扫描范围

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
  const proj = st.project || projectName(); // 计划任务环境无项目目录变量，用状态里固化的
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

function dayLogFiles() {
  // 今天 + 昨天：回合跨午夜时最后的活动可能记在昨天的日志里
  const files = [];
  for (const off of [0, 86400000]) {
    const dt = new Date(Date.now() - off);
    const name = `zcode-${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}.jsonl`;
    const p = path.join(LOG_DIR, name);
    try {
      if (fs.statSync(p).isFile()) files.push(p);
    } catch { /* 该日无日志 */ }
  }
  return files;
}

// 在日志尾部找该会话最后一条记录：返回 { last: UTC毫秒 }
function lastActivityFor(sid, files) {
  let last = 0;
  for (const p of files) {
    let st;
    try { st = fs.statSync(p); } catch { continue; }
    const size = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes(`"${sid}"`)) continue;
      const m = line.match(/"timestamp":"([^"]+)"/);
      const t = m ? Date.parse(m[1]) : NaN;
      if (Number.isFinite(t) && t > last) last = t;
      break; // 该文件里最后一条即停（日志按时间追加）
    }
  }
  return last;
}

async function poll() {
  let files = [];
  try {
    files = fs.readdirSync(STATE_DIR).filter(f => f.startsWith('session-'));
  } catch { return; }
  if (files.length === 0) return;

  const dayFiles = dayLogFiles();
  if (dayFiles.length === 0) return; // 没有日志可判定
  const currentKeys = new Set();
  const stall = stallMs();

  for (const f of files) {
    let st;
    try { st = JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')); } catch { continue; }
    const sid = f.replace(/^session-/, '').replace(/\.json$/, '');
    if (!sid || sid === 'unknown') continue;
    const alertKey = `${f}:${st.turnId || ''}`;
    currentKeys.add(alertKey);
    if (mem.alerted[alertKey]) continue; // 该回合已报警

    const last = lastActivityFor(sid, dayFiles);
    if (!last) continue; // 日志里查无此会话（如看门狗中途加入），宁缺勿滥
    if (last > (mem.lastSeen[alertKey] || 0)) {
      mem.lastSeen[alertKey] = last;
      saveMem();
    }
    const seen = mem.lastSeen[alertKey] || 0;
    if (!seen) continue;
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
  saveMem();
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  try { mem = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch { /* 首次运行 */ }
  await poll();
  saveMem();
}

main().catch(e => { console.error(`qq-notify-watchdog: ${e?.message || e}`); process.exit(0); });
