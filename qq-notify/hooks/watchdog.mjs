// qq-notify 看门狗 — 单次巡检（由 Windows 计划任务每分钟调起，跑完即退）
// 通知源 = ZCode 运行日志 + 会话数据库，不依赖 hook —— 老对话、SSH 对话、
// 后台任务子会话一律覆盖（hook 只负责确保本计划任务注册，见 notify.mjs）。
//   turn.completed 且时长 ≥ 通知阈值 → "✅ 任务完成"
//   turn.started 后该会话日志沉默超过失联阈值 → "⚠️ 任务中断"（每回合最多一次）
// 环境变量:
//   QQ_NOTIFY_THRESHOLD_SECONDS  通知阈值（秒），优先级最高
//   QQ_NOTIFY_STALL_MINUTES      失联阈值（分钟），优先级最高
//   QQ_NOTIFY_LOG_DIR / QQ_NOTIFY_DB_PATH / QQ_NOTIFY_STATE_DIR  路径覆盖（测试用）
//   QMSG_KEY / QQ_NOTIFY_DRY_RUN 同 notify.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = process.env.QQ_NOTIFY_LOG_DIR || path.join(os.homedir(), '.zcode', 'cli', 'log');
const DB_PATH = process.env.QQ_NOTIFY_DB_PATH || path.join(os.homedir(), '.zcode', 'cli', 'db', 'db.sqlite');
const ROOT = path.join(os.tmpdir(), 'qq-notify-watchdog');
const MEM_FILE = path.join(ROOT, 'memory.json');
const TAIL_BYTES = 8 * 1024 * 1024; // 当日日志最大读取范围

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

function thresholdSec() {
  const envV = Number(process.env.QQ_NOTIFY_THRESHOLD_SECONDS);
  if (Number.isFinite(envV) && envV > 0) return envV;
  const cfgV = Number(loadConfig().thresholdSeconds);
  if (Number.isFinite(cfgV) && cfgV > 0) return cfgV;
  return 600;
}

function stallMs() {
  const envV = Number(process.env.QQ_NOTIFY_STALL_MINUTES);
  if (Number.isFinite(envV) && envV > 0) return envV * 60000;
  const cfgV = Number(loadConfig().stallMinutes);
  if (Number.isFinite(cfgV) && cfgV > 0) return cfgV * 60000;
  return 5 * 60000;
}

function sanitize(text) {
  return String(text || '')
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/\d{7,}/g, '…')
    .replace(/[#*`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
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

// —— 会话数据库（只读，失败返回 null，通知仍可发送只是缺素材）——
function withDb(fn) {
  let dbh = null;
  try {
    dbh = new DatabaseSync(DB_PATH, { readOnly: true });
    return fn(dbh);
  } catch { return null; }
  finally { try { dbh?.close(); } catch { /* 忽略 */ } }
}

function sessionTitle(dbh, sid) {
  if (!dbh) return '';
  try {
    const r = dbh.prepare('SELECT title FROM session WHERE id = ?').get(sid);
    return String(r?.title || '');
  } catch { return ''; }
}

function lastPromptBefore(dbh, sid, ts) {
  if (!dbh) return '';
  try {
    const r = dbh.prepare(
      'SELECT text FROM input_history WHERE session_id = ? AND time_created <= ? ORDER BY time_created DESC LIMIT 1',
    ).get(sid, ts);
    return String(r?.text || '');
  } catch { return ''; }
}

// 从 message.data 提取文本（结构防御式解析）
function messageText(data) {
  try {
    const d = typeof data === 'string' ? JSON.parse(data) : data;
    if (typeof d?.text === 'string' && d.text.trim()) return d.text;
    if (Array.isArray(d?.parts)) {
      const t = d.parts.filter(p => p?.type === 'text' || typeof p?.text === 'string')
        .map(p => p?.text || '').join(' ');
      if (t.trim()) return t;
    }
    if (typeof d?.content === 'string' && d.content.trim()) return d.content;
  } catch { /* 忽略 */ }
  return '';
}

function lastAssistantTextBefore(dbh, sid, ts) {
  if (!dbh) return '';
  try {
    const rows = dbh.prepare(
      'SELECT data FROM message WHERE session_id = ? ORDER BY sequence DESC LIMIT 8',
    ).all(sid);
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        const created = d?.time?.completed || d?.time?.created || 0;
        if (d?.role !== 'assistant') continue;
        if (created && created > ts) continue; // 只取回合结束前产生的消息
        const text = messageText(d);
        if (text.trim()) return text;
      } catch { continue; }
    }
  } catch { /* 忽略 */ }
  return '';
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

let mem = { notified: {}, lastSeen: {} };
function saveMem() {
  try { fs.writeFileSync(MEM_FILE, JSON.stringify(mem)); } catch { /* 忽略 */ }
}

// 解析当日日志，聚合回合生命周期与本会话最后活动时间
function scanLog() {
  const dt = new Date();
  const name = `zcode-${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}.jsonl`;
  const p = path.join(LOG_DIR, name);
  let raw = '';
  try {
    const st = fs.statSync(p);
    const size = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    raw = buf.toString('utf8');
  } catch { return { turns: {}, sessionLast: {} }; }

  const turns = {};        // turnId → { sess, started, completed, tools }
  const sessionLast = {};  // sid → { ts: 最后一条日志的 UTC 毫秒, evt: 事件名 }
  for (const line of raw.split('\n')) {
    if (!line.startsWith('{')) continue;
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    const sid = j.sessionId || '';
    const ts = Date.parse(j.timestamp || '');
    if (sid && Number.isFinite(ts)) {
      const cur = sessionLast[sid];
      // 同毫秒事件按文件顺序后写优先
      if (!cur || ts >= cur.ts) sessionLast[sid] = { ts, evt: String(j.event || j.message || '') };
    }
    if (j.event !== 'turn.started' && j.event !== 'turn.completed') continue;
    const tid = j.turnId || '';
    if (!tid) continue;
    turns[tid] = turns[tid] || { sess: sid, started: 0, completed: 0, tools: 0 };
    if (j.event === 'turn.started') {
      turns[tid].sess = sid;
      turns[tid].started = Date.parse(j.timestamp);
    } else {
      turns[tid].completed = Date.parse(j.timestamp);
      turns[tid].tools = j.context?.toolCallCount ?? 0;
    }
  }
  return { turns, sessionLast };
}

async function poll() {
  const { turns, sessionLast } = scanLog();
  const stall = stallMs();
  const th = thresholdSec();
  const seenKeys = new Set();

  for (const [tid, t] of Object.entries(turns)) {
    if (!t.sess) continue;
    const key = `${tid}:${t.sess.slice(5, 13)}`;
    seenKeys.add(key);

    if (t.completed) {
      // —— 正常完成 → 达标则 ✅ ——
      if (mem.notified[key]) continue;
      mem.notified[key] = 'skip'; // 先占位，防止巡检并发重复
      saveMem();
      if (!t.started) continue; // 起点（昨日）不在当日日志，时长不可知
      const durSec = (t.completed - t.started) / 1000;
      if (durSec < th) continue; // 未达阈值
      const info = withDb(db => ({
        title: sessionTitle(db, t.sess),
        label: lastPromptBefore(db, t.sess, t.completed),
        summary: lastAssistantTextBefore(db, t.sess, t.completed),
      })) || {};
      const lines = ['✅ 任务完成'];
      if (info.title) lines.push(`对话：${sanitize(info.title).slice(0, 40)}`);
      if (info.label) lines.push(`任务：${sanitize(info.label).slice(0, 40)}`);
      lines.push(`耗时：${formatDuration(durSec)}`);
      lines.push(`工具调用：${t.tools}次`);
      const summary = sanitize(info.summary);
      if (summary) lines.push(`📝 ${summary}`);
      await send(lines.join('\n'));
      mem.notified[key] = 'done';
      saveMem();
    } else {
      // —— 已开始未完成 → 会话日志沉默达到失联阈值则 ⚠️ ——
      if (mem.notified[key]) continue;
      const act = sessionLast[t.sess];
      const last = act ? act.ts : 0;
      if (last > (mem.lastSeen[key] || 0)) {
        mem.lastSeen[key] = last;
        saveMem();
      }
      const seen = mem.lastSeen[key] || 0;
      if (!seen) continue; // 会话在日志中查无活动，宁缺勿滥
      if (Date.now() - seen < stall) continue; // 还活着
      // 最后一条事件是请求/工具"开始"型 = 有东西在途（长工具调用、生成中），不算失联
      if (act && /^(model\.request|tool\.call)\.started$/.test(act.evt)) continue;
      if (!zcodeRunning()) continue; // 应用已关闭：不标记不报警，恢复后补报
      mem.notified[key] = 'aborted';
      saveMem();
      const info = withDb(db => ({
        title: sessionTitle(db, t.sess),
        label: lastPromptBefore(db, t.sess, Date.now()),
      })) || {};
      const lines = ['⚠️ 任务中断'];
      if (info.title) lines.push(`对话：${sanitize(info.title).slice(0, 40)}`);
      if (info.label) lines.push(`任务：${sanitize(info.label).slice(0, 40)}`);
      lines.push(`已运行：${formatDuration((Date.now() - t.started) / 1000)}后失联`);
      lines.push('（回合未正常结束，请回 ZCode 查看）');
      await send(lines.join('\n'));
    }
  }

  // 记忆清理：当日日志中已不见的回合（且非今日新增）逐出，防止无限增长
  for (const key of Object.keys(mem.notified)) {
    const tid = key.slice(0, key.lastIndexOf(':'));
    if (!turns[tid]) delete mem.notified[key];
  }
  for (const key of Object.keys(mem.lastSeen)) {
    if (!turns[key.slice(0, key.lastIndexOf(':'))]) delete mem.lastSeen[key];
  }
  saveMem();
}

async function main() {
  fs.mkdirSync(ROOT, { recursive: true });
  try { mem = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch { /* 首次运行 */ }
  mem.notified = mem.notified || {};   // 兼容旧版 memory 格式
  mem.lastSeen = mem.lastSeen || {};
  await poll();
  saveMem();
}

main().catch(e => { console.error(`qq-notify-watchdog: ${e?.message || e}`); process.exit(0); });
