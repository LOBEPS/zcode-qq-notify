// qq-notify 看门狗 — 单次巡检（由 Windows 计划任务每分钟调起，跑完即退）
// ═══════════════════════════════════════════════════════════════════
// 运行位置：~/.qq-notify/watchdog.mjs（notify.mjs 维护的稳定副本）。
// 配置来源：环境变量 > ~/.qq-notify.json（用户级，更新免疫）> 内置默认。
// ZCode 触点全部经 zcode-adapter.mjs（COMPAT-1~7，见 COMPATIBILITY.md）。
// 自诊断：node watchdog.mjs --doctor；调试：QQ_NOTIFY_DEBUG=1；
// 测试钩子：QQ_NOTIFY_QMSG_FAKE=1（假发送，不联网）。
//
// 发送策略（v1.2.0 低延迟流水线）：
//   ① 按完成时间倒序处理——最新的通知最先发出
//   ② 发送阶段只按 Qmsg 限流节奏（5.5秒/条）推进，不等回执
//   ③ 回执核验（违规自愈）在流水线尾部统一完成，与发送时间重叠
//   ④ 积压截断：完成超过 backlogMinutes(默认30分钟) 的未标记历史不补发
//      （杜绝看门狗停机/记忆重置后的补发洪峰挤占通道）
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ZC from './zcode-adapter.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const USER_DIR = path.join(os.homedir(), '.qq-notify');
const OP_LOG = path.join(USER_DIR, 'watchdog.log');
const ROOT = path.join(os.tmpdir(), 'qq-notify-watchdog');
const MEM_FILE = path.join(ROOT, 'memory.json');
const RUN_LOCK = path.join(ROOT, 'run.lock');
const TAIL_BYTES = 8 * 1024 * 1024;  // 单个日志文件最大读取范围
const FAIL_GRACE_MS = 2 * 60000;     // Turn failed 后的宽限期（SDK 可能仍在重试）
const SEND_PACE_MS = 5500;           // Qmsg 限流：同一 key 每 5 秒 1 条
const FAKE_QMSG = process.env.QQ_NOTIFY_QMSG_FAKE === '1';

// node:sqlite 需要 Node ≥ 22.5；加载失败时降级为无数据库模式（通知缺素材但不中断）
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 降级 */ }

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(line) {
  console.error(line);
  try {
    fs.mkdirSync(USER_DIR, { recursive: true });
    fs.appendFileSync(OP_LOG, `${new Date().toISOString()} ${line}\n`);
    if (fs.statSync(OP_LOG).size > 262144) {
      fs.writeFileSync(OP_LOG, fs.readFileSync(OP_LOG, 'utf8').slice(-131072));
    }
  } catch { /* 日志失败不影响功能 */ }
}

// ── 配置：环境变量 > ~/.qq-notify.json > 内置默认 ──
function settings() {
  let user = {};
  try { user = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.qq-notify.json'), 'utf8')); } catch { /* 无用户配置 */ }
  const num = v => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : null);
  return {
    key: process.env.QMSG_KEY || user.qmsgKey || '',
    thresholdSec: num(process.env.QQ_NOTIFY_THRESHOLD_SECONDS) ?? num(user.thresholdSeconds) ?? 600,
    stallMs: (num(process.env.QQ_NOTIFY_STALL_MINUTES) ?? num(user.stallMinutes) ?? 5) * 60000,
    capMs: (num(process.env.QQ_NOTIFY_INFLIGHT_CAP_MINUTES) ?? num(user.inFlightCapMinutes) ?? 30) * 60000, // 工具黑洞上限
    reqCapMs: (num(process.env.QQ_NOTIFY_REQ_CAP_MINUTES) ?? num(user.reqCapMinutes) ?? 60) * 60000,        // 请求孤儿兜底上限
    backlogMs: (num(process.env.QQ_NOTIFY_BACKLOG_MINUTES) ?? num(user.backlogMinutes) ?? 30) * 60000,      // 积压截断
  };
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

// ── Qmsg 收发（FAKE 模式用于测试）──
let fakeSeq = 0;
async function qmsgSend(key, text) {
  if (FAKE_QMSG) {
    fakeSeq++;
    log(`[FAKE] 发送#${fakeSeq}: ${String(text).split('\n')[0].slice(0, 30)}`);
    return { ok: true, msgId: `fake-${fakeSeq}` };
  }
  const res = await fetch(
    `https://qmsg.zendee.cn/v3/send/${key}?msg=${encodeURIComponent(text)}`,
    { signal: AbortSignal.timeout(8000) },
  );
  const body = await res.json().catch(() => ({}));
  return { ok: !!body.success, msgId: body.data };
}

async function qmsgStatus(key, msgId) {
  if (FAKE_QMSG) return 1;
  try {
    const res = await fetch(
      `https://qmsg.zendee.cn/v3/msg/status/${key}?msgId=${msgId}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const body = await res.json().catch(() => ({}));
    return body.data; // 0未回执 1成功 2违规 -1失败
  } catch { return 0; }
}

let mem = { notified: {}, sendFail: {} };
function saveMem() {
  try { fs.writeFileSync(MEM_FILE, JSON.stringify(mem)); } catch { /* 忽略 */ }
}

// 巡检互斥锁：仅当上一个巡检进程确实还活着（且未超10分钟）才跳过
function touchRunLock() {
  try { fs.utimesSync(RUN_LOCK, new Date(), new Date()); } catch {
    try { fs.writeFileSync(RUN_LOCK, String(process.pid)); } catch { /* 忽略 */ }
  }
}

// ── 日志扫描（今天 + 昨天，事件名/字段经适配层）──
function scanLog() {
  const turns = {};
  for (const p of ZC.logFilePaths()) {
    let raw = '';
    try {
      const st = fs.statSync(p);
      const size = Math.min(st.size, TAIL_BYTES);
      const buf = Buffer.alloc(size);
      const fd = fs.openSync(p, 'r');
      fs.readSync(fd, buf, 0, size, st.size - size);
      fs.closeSync(fd);
      raw = buf.toString('utf8');
    } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.startsWith('{')) continue;
      let j;
      try { j = JSON.parse(line); } catch { continue; }
      const tid = ZC.extractTurnId(j);
      if (!tid) continue;
      const ts = ZC.extractTimestamp(j);
      if (!Number.isFinite(ts)) continue;
      const kind = ZC.eventKind(j.event || '');
      // 错误事件（level:error，无 event 字段但有 message）必须放行——它是回合失败的判定信号
      if (!kind && !j.event && !j.message) continue;
      const t = turns[tid] = turns[tid] || {
        sess: ZC.extractSessionId(j), started: 0, completed: 0, tools: 0,
        lastTs: 0, lastEvt: '', reqS: 0, reqC: 0, toolS: 0, toolC: 0, failTs: 0,
      };
      if (ZC.extractSessionId(j)) t.sess = ZC.extractSessionId(j);
      if (ts >= t.lastTs) { t.lastTs = ts; t.lastEvt = String(j.event || j.message || ''); }
      if (kind === 'turnStarted') t.started = ts;
      else if (kind === 'turnCompleted') { t.completed = ts; t.tools = ZC.extractToolCount(j); }
      else if (kind === 'reqStarted') t.reqS++;
      else if (kind === 'reqCompleted') t.reqC++;
      else if (kind === 'toolStarted') t.toolS++;
      else if (kind === 'toolCompleted') t.toolC++;
      // 回合失败信号（SDK 重试穷尽后 ZCode 记录的错误事件，带 turnId）
      if (j.level === 'error' && /Turn failed|stream failed/i.test(String(j.message || ''))) t.failTs = ts;
    }
  }
  return turns;
}

function withDb(fn) {
  if (!DatabaseSync) return fn(null); // Node < 22.5 或加载失败：降级
  const p = ZC.findDbPath();
  if (!p) return fn(null);
  let db = null;
  try {
    db = new DatabaseSync(p, { readOnly: true });
    return fn(db);
  } catch { return fn(null); }
  finally { try { db?.close(); } catch { /* 忽略 */ } }
}

const TERMINAL = ['done', 'skip', 'failed', 'nokey', 'aborted', 'sent', 'stopped'];

async function poll() {
  const turns = scanLog();
  const cfg = settings();
  const dbg = process.env.QQ_NOTIFY_DEBUG === '1';
  if (dbg) log(`巡检: 回合数=${Object.keys(turns).length} 阈值=${cfg.thresholdSec}s 失联=${cfg.stallMs / 60000}分 工具上限=${cfg.capMs / 60000}分 请求兜底=${cfg.reqCapMs / 60000}分 积压截断=${cfg.backlogMs / 60000}分`);

  // 按时间倒序：最新完成的先通知（降低新鲜通知延迟）
  const list = Object.entries(turns).sort((a, b) =>
    (b[1].completed || b[1].started || 0) - (a[1].completed || a[1].started || 0));

  // 各会话最新回合起点：用于识别"已被新回合取代的旧回合"
  const latestBySess = {};
  for (const [, t] of list) {
    if (t.started && (latestBySess[t.sess] === undefined || t.started > latestBySess[t.sess])) latestBySess[t.sess] = t.started;
  }

  // ── 发送流水线：只按限流节奏推进，回执核验推迟到尾部 ──
  let lastSendAt = 0;
  const receipts = [];
  async function deliver(kind, text, fallbackText, memKey) {
    if (process.env.QQ_NOTIFY_DRY_RUN === '1') {
      log(`DRY RUN 未发送:\n${text}`);
      mem.notified[memKey] = kind;
      return;
    }
    if (!cfg.key) { mem.notified[memKey] = 'nokey'; saveMem(); return; }
    const fails = mem.sendFail?.[memKey] || 0;
    if (fails >= 3) { mem.notified[memKey] = 'failed'; saveMem(); return; }
    const gap = SEND_PACE_MS - (Date.now() - lastSendAt);
    if (gap > 0) await sleep(gap);
    lastSendAt = Date.now();
    touchRunLock();
    try {
      const r = await qmsgSend(cfg.key, text);
      if (!r.ok || !r.msgId) throw new Error('发送被拒绝');
      mem.notified[memKey] = 'sent'; // 先落账防双发；回执阶段定稿
      receipts.push({ msgId: r.msgId, sentAt: lastSendAt, kind, text, fallbackText, memKey });
    } catch (e) {
      log(`发送失败 ${memKey.slice(0, 24)}… ${e?.message || e}`);
      mem.sendFail = mem.sendFail || {};
      mem.sendFail[memKey] = fails + 1;
    }
    saveMem();
  }

  for (const [tid, t] of list) {
    if (!t.sess) continue;
    const key = `${tid}:${t.sess.slice(5, 13)}`;
    if (TERMINAL.includes(mem.notified[key])) continue;

    if (t.completed) {
      // —— 正常完成 → 达标且不积压则 ✅ ——
      if (!t.started) { mem.notified[key] = 'skip'; saveMem(); continue; }
      const durSec = (t.completed - t.started) / 1000;
      if (durSec < cfg.thresholdSec) { mem.notified[key] = 'skip'; saveMem(); continue; }
      if (Date.now() - t.completed > cfg.backlogMs) {
        log(`积压截断: ${tid.slice(5, 13)} 完成于 ${Math.round((Date.now() - t.completed) / 60000)} 分钟前，不补发`);
        mem.notified[key] = 'skip'; saveMem(); continue;
      }
      const info = withDb(db => ({
        title: db ? ZC.dbSessionTitle(db, t.sess) : '',
        label: db ? ZC.dbLastPrompt(db, t.sess, t.completed) : '',
        summary: db ? ZC.dbLastAssistantText(db, t.sess, t.completed) : '',
      })) || {};
      const lines = ['✅ 任务完成'];
      if (info.title) lines.push(`对话：${sanitize(info.title).slice(0, 40)}`);
      if (info.label) lines.push(`任务：${sanitize(info.label).slice(0, 40)}`);
      lines.push(`耗时：${formatDuration(durSec)}`);
      lines.push(`工具调用：${t.tools}次`);
      const summary = sanitize(info.summary);
      if (summary) lines.push(`📝 ${summary}`);
      await deliver('done', lines.join('\n'),
        ['✅ 任务完成（通知详情被过滤，请回 ZCode 查看）', `耗时：${formatDuration(durSec)}`, `工具调用：${t.tools}次`].join('\n'), key);
    } else {
      // —— 已开始未完成：分级判定 ——
      // ① Turn failed 失败终态 → 2 分钟宽限后即刻报警（SDK 重试期间 lastEvt 回到 started，不算终态）
      // ② 被同会话更新回合取代 → 静默终结（用户已在新回合交互，在场，无需打扰）
      // ③ 请求在途（思考/生成）→ 兜底上限（默认60分钟）内不报，防孤儿请求永不报警
      // ④ 工具在途（长命令）→ 黑洞上限（默认30分钟）内不报
      // ⑤ 无在途 + 沉默超失联阈值（默认5分钟）→ 报警
      if (!t.lastTs) continue;
      // 权威状态核对（turn_usage 表）：手动停止与自然失败在日志里都记 turn.failed，只有数据库能区分
      const tu = withDb(db => (db ? ZC.dbTurnStatus(db, tid) : null));
      if (tu?.cancelled) {
        log(`用户手动停止，静默终结: ${tid.slice(5, 13)}`);
        mem.notified[key] = 'stopped'; saveMem(); continue;
      }
      if (tu?.status === 'completed') {
        // 数据库说已完成但日志缺 turn.completed（极端边缘）：不报警
        mem.notified[key] = 'skip'; saveMem(); continue;
      }
      const silence = Date.now() - t.lastTs;
      const failFresh = t.failTs && t.failTs >= t.lastTs && (Date.now() - t.failTs) >= FAIL_GRACE_MS;
      const superseded = latestBySess[t.sess] > (t.started || 0);
      const inFlightReq = t.reqS > t.reqC;
      const inFlightTool = t.toolS > t.toolC;
      if (dbg) log(`评估 ${tid.slice(5, 13)}: silence=${Math.round(silence / 1000)}s req=${t.reqS}/${t.reqC} tool=${t.toolS}/${t.toolC} lastEvt=${t.lastEvt.slice(0, 24)} failFresh=${!!failFresh} superseded=${superseded} think=${inFlightReq} toolInFlight=${inFlightTool}`);
      if (superseded && !failFresh) {
        log(`回合被取代，静默终结: ${tid.slice(5, 13)}`);
        mem.notified[key] = 'aborted'; saveMem(); continue;
      }
      if (!failFresh) {
        if (silence < cfg.stallMs) continue;
        if (inFlightReq && silence < cfg.reqCapMs) continue;
        if (inFlightTool && silence < cfg.capMs) continue;
      }
      if (!ZC.zcodeProcessRunning(execSync)) continue; // 应用已关闭：不报警，恢复后补报
      const info = withDb(db => ({
        title: db ? ZC.dbSessionTitle(db, t.sess) : '',
        label: db ? ZC.dbLastPrompt(db, t.sess, Date.now()) : '',
      })) || {};
      const lines = ['⚠️ 任务中断'];
      if (info.title) lines.push(`对话：${sanitize(info.title).slice(0, 40)}`);
      if (info.label) lines.push(`任务：${sanitize(info.label).slice(0, 40)}`);
      lines.push(`已运行：${formatDuration((Date.now() - t.started) / 1000)}后失联`);
      lines.push('（回合未正常结束，请回 ZCode 查看）');
      await deliver('aborted', lines.join('\n'),
        ['⚠️ 任务中断（详情被过滤，请回 ZCode 查看）', `已运行：${formatDuration((Date.now() - t.started) / 1000)}后失联`].join('\n'), key);
    }
  }

  // ── 第二阶段：回执核验（此时多数消息已过限流间隔，几乎零等待）──
  for (const r of receipts) {
    if (Date.now() - r.sentAt < 5000) await sleep(5000 - (Date.now() - r.sentAt));
    let st = await qmsgStatus(cfg.key, r.msgId);
    if (st === 0) { await sleep(4000); st = await qmsgStatus(cfg.key, r.msgId); } // 回执未返，再等一轮
    log(`回执 ${r.msgId} = ${st}`);
    if (st === 1 || st === 0) {
      mem.notified[r.memKey] = r.kind;
      if (mem.sendFail) delete mem.sendFail[r.memKey];
    } else if (st === 2 && r.fallbackText) {
      // 内容被云过滤误伤 → 降级为通用文案重发
      log(`内容违规，降级重发 ${r.memKey.slice(0, 24)}…`);
      const gap = SEND_PACE_MS - (Date.now() - lastSendAt);
      if (gap > 0) await sleep(gap);
      lastSendAt = Date.now();
      const r2 = await qmsgSend(cfg.key, r.fallbackText);
      if (r2.ok && r2.msgId) {
        await sleep(5000);
        const st2 = await qmsgStatus(cfg.key, r2.msgId);
        log(`降级回执 ${r2.msgId} = ${st2}`);
        mem.notified[r.memKey] = (st2 === 2 || st2 === -1) ? 'failed' : r.kind;
      } else {
        mem.notified[r.memKey] = 'failed';
      }
    } else {
      // st === -1 发送失败：重试一次
      const gap = SEND_PACE_MS - (Date.now() - lastSendAt);
      if (gap > 0) await sleep(gap);
      lastSendAt = Date.now();
      const r3 = await qmsgSend(cfg.key, r.text);
      log(`失败重试 ${r.msgId} → ${r3.ok}`);
      mem.notified[r.memKey] = r3.ok ? r.kind : 'failed';
    }
    saveMem();
  }
}

// ── 自诊断：ZCode 更新导致失效时，运行 --doctor 精确定位 ──
async function doctor() {
  const R = [];
  const check = (id, name, fn) => {
    try { R.push({ id, name, ...fn() }); } catch (e) { R.push({ id, name, ok: false, msg: e?.message || String(e) }); }
  };

  check('COMPAT-1', 'ZCode 数据目录', () => {
    const d = ZC.findZcodeDir();
    return d ? { ok: true, msg: d } : { ok: false, msg: '候选路径均不存在 → zcode-adapter.mjs 的 ZCODE_DIR_CANDIDATES' };
  });
  check('COMPAT-2', '运行日志目录', () => {
    const d = ZC.findLogDir();
    const files = ZC.logFilePaths();
    return files.length ? { ok: true, msg: `${d}（今日+昨日 ${files.length} 个文件）` } : { ok: false, msg: '找不到日志文件 → 适配层 findLogDir/logFilePaths' };
  });
  check('COMPAT-3', '事件名识别', () => {
    const turns = scanLog();
    const n = Object.keys(turns).length;
    let totalLines = 0;
    try {
      const files = ZC.logFilePaths();
      if (files.length) {
        const raw = fs.readFileSync(files[0], 'utf8');
        totalLines = raw.split('\n').filter(l => l.startsWith('{')).length;
      }
    } catch { /* 忽略 */ }
    if (n > 0) return { ok: true, msg: `识别到 ${n} 个回合` };
    if (totalLines > 500) return { ok: false, msg: `日志有 ${totalLines} 行但 0 个回合——事件名已变更 → 适配层 EVENTS` };
    return { ok: true, msg: `今日暂无回合（日志 ${totalLines} 行），事件解析正常` };
  });
  check('COMPAT-5/6', '会话数据库', () => {
    if (!DatabaseSync) return { ok: false, warn: true, msg: 'Node < 22.5，无 node:sqlite——通知将缺少对话名/摘要（不影响发送）' };
    const p = ZC.findDbPath();
    if (!p) return { ok: false, msg: '找不到 db.sqlite → 适配层 findDbPath' };
    let db = null;
    try {
      db = new DatabaseSync(p, { readOnly: true });
      const r = db.prepare('SELECT id, title FROM session LIMIT 1').get();
      return { ok: true, msg: `${p}（示例: ${String(r?.title || '(空表)').slice(0, 30)}）` };
    } catch (e) {
      return { ok: false, msg: `打开/查询失败: ${e.message} → 适配层 db* 查询` };
    } finally { try { db?.close(); } catch { } }
  });
  check('COMPAT-7', 'ZCode 进程检测', () => {
    const ok = ZC.zcodeProcessRunning(execSync);
    return ok ? { ok: true, msg: '检测到 ZCode 运行中' } : { ok: false, warn: true, msg: '未检测到 ZCode 进程（若 ZCode 确在运行 → 适配层 PROCESS_PATTERNS；中断报警将被抑制）' };
  });
  check('CONF', 'key 配置', () => {
    const { key } = settings();
    return key ? { ok: true, msg: `已配置（${key.slice(0, 6)}…${key.slice(-4)}）` } : { ok: false, msg: '未配置 → ~/.qq-notify.json 的 qmsgKey 或环境变量 QMSG_KEY' };
  });
  check('TASK', '计划任务', () => {
    try {
      execSync('schtasks /Query /TN "qq-notify-watchdog"', { timeout: 8000, windowsHide: true, stdio: 'ignore' });
      return { ok: true, msg: 'qq-notify-watchdog 已注册（任意对话发条消息可触发自愈校正）' };
    } catch {
      return { ok: false, msg: '计划任务丢失 → 在任意 ZCode 对话发一条消息触发重注册，或见 README 手动注册' };
    }
  });

  console.log('\nqq-notify 自诊断（v1.2.0）');
  console.log('═'.repeat(64));
  for (const r of R) {
    const flag = r.ok ? (r.warn ? '⚠️ ' : '✅') : '❌';
    console.log(`${flag} [${r.id}] ${r.name}: ${r.msg}`);
  }
  console.log('═'.repeat(64));
  console.log('修复指引：失败项 → COMPATIBILITY.md 对应条目 → zcode-adapter.mjs 对应段落');
  console.log(`运行日志尾部（${OP_LOG}）：`);
  try {
    const tail = fs.readFileSync(OP_LOG, 'utf8').trim().split('\n').slice(-5);
    tail.forEach(l => console.log('  ' + l));
  } catch { console.log('  （尚无日志）'); }
}

async function main() {
  if (process.argv.includes('--doctor')) { await doctor(); return; }
  fs.mkdirSync(ROOT, { recursive: true });
  try {
    const st = fs.statSync(RUN_LOCK);
    const pid = Number(fs.readFileSync(RUN_LOCK, 'utf8')) || 0;
    let alive = false;
    if (pid) { try { process.kill(pid, 0); alive = true; } catch (e) { alive = e.code === 'EPERM'; } }
    if (alive && Date.now() - st.mtimeMs < 600000) process.exit(0); // 上一次巡检确实还在跑
  } catch { /* 无锁或锁损坏，继续 */ }
  try { fs.writeFileSync(RUN_LOCK, String(process.pid)); } catch { /* 尽力而为 */ }
  try { mem = JSON.parse(fs.readFileSync(MEM_FILE, 'utf8')); } catch { /* 首次运行 */ }
  mem.notified = mem.notified || {};
  mem.lastSeen = mem.lastSeen || {};
  mem.sendFail = mem.sendFail || {};
  await poll();
  saveMem();
}

main().catch(e => { log(`巡检异常: ${e?.message || e}`); process.exit(0); });
