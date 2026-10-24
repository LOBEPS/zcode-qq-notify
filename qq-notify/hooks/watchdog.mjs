// qq-notify 看门狗 — 单次巡检（由 Windows 计划任务每分钟调起，跑完即退）
// ═══════════════════════════════════════════════════════════════════
// 运行位置：~/.qq-notify/watchdog.mjs（由 notify.mjs 维护的稳定副本，
// 与插件版本目录解耦——插件更新/缓存路径变化不影响计划任务）。
// 配置来源：环境变量 > ~/.qq-notify.json（用户级，更新免疫）> 内置默认。
// 所有 ZCode 相关路径/事件名/表结构一律通过 zcode-adapter.mjs 访问。
// 自诊断：node watchdog.mjs --doctor（ZCode 更新后先跑这个定位问题）。
// 运行日志：~/.qq-notify/watchdog.log（自动滚动，保留最近 128KB）。
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
const TAIL_BYTES = 8 * 1024 * 1024; // 单个日志文件最大读取范围
const FAIL_GRACE_MS = 2 * 60000;    // Turn failed 后的宽限期（SDK 可能仍在重试）

// node:sqlite 需要 Node ≥ 22.5；加载失败时降级为无数据库模式（通知缺素材但不中断）
let DatabaseSync = null;
try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* 降级 */ }

// ── 可观测性：所有关键动作落盘 ──
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
    capMs: (num(process.env.QQ_NOTIFY_INFLIGHT_CAP_MINUTES) ?? num(user.inFlightCapMinutes) ?? 30) * 60000,
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

// ── Qmsg 发送（带违规自愈）──
// Qmsg 的内容过滤是云识别、异步判定：发送接口返回 success:true 也可能事后判违规（状态2）不投递。
// 因此发送后轮询回执：违规 → 自动降级为通用文案重发，保证通知一定到达。
async function qmsgSend(key, text) {
  const res = await fetch(
    `https://qmsg.zendee.cn/v3/send/${key}?msg=${encodeURIComponent(text)}`,
    { signal: AbortSignal.timeout(8000) },
  );
  const body = await res.json().catch(() => ({}));
  return { ok: !!body.success, msgId: body.data };
}

async function qmsgStatus(key, msgId) {
  try {
    const res = await fetch(
      `https://qmsg.zendee.cn/v3/msg/status/${key}?msgId=${msgId}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const body = await res.json().catch(() => ({}));
    return body.data; // 0未回执 1成功 2违规 -1失败
  } catch { return 0; }
}

async function send(text, fallbackText) {
  const { key } = settings();
  if (!key) {
    log('未配置 key（QMSG_KEY 环境变量 / ~/.qq-notify.json 的 qmsgKey 均为空）');
    return 'nokey';
  }
  if (process.env.QQ_NOTIFY_DRY_RUN === '1') {
    log(`DRY RUN 未发送:\n${text}`);
    return true;
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await qmsgSend(key, text);
      if (!r.ok || !r.msgId) throw new Error('发送被拒绝');
      touchRunLock();
      let st = 0;
      for (const wait of [5000, 8000]) { // 等异步回执（QQ 返回 + 违规判定）
        await new Promise(rs => setTimeout(rs, wait));
        st = await qmsgStatus(key, r.msgId);
        if (st !== 0) break;
      }
      log(`发送 msgId=${r.msgId} 回执=${st}${st === 2 ? '（违规，降级重发）' : ''}`);
      if (st === 1 || st === 0) return true;
      if (st === 2 && fallbackText) {
        await new Promise(rs => setTimeout(rs, 6000)); // 限流 1条/5秒
        const r2 = await qmsgSend(key, fallbackText);
        if (r2.ok && r2.msgId) {
          await new Promise(rs => setTimeout(rs, 6000));
          const st2 = await qmsgStatus(key, r2.msgId);
          log(`降级重发 msgId=${r2.msgId} 回执=${st2}`);
          return st2 === 1 || st2 === 0;
        }
        return false;
      }
      // st === -1 发送失败 → 走重试
    } catch (e) {
      log(`发送失败 ${e?.cause?.message || e?.message || e}`);
    }
    if (attempt === 0) await new Promise(r => setTimeout(r, 6000));
  }
  return false;
}

let mem = { notified: {}, lastSeen: {}, sendFail: {} };
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
      lastTs: 0, lastEvt: String(j.event || j.message || ''), reqS: 0, reqC: 0, toolS: 0, toolC: 0,
      failTs: 0,
    };
    if (ZC.extractSessionId(j)) t.sess = ZC.extractSessionId(j);
    if (ts >= t.lastTs && kind) { t.lastTs = ts; t.lastEvt = String(j.event || ''); } else if (ts >= t.lastTs) { t.lastTs = ts; t.lastEvt = String(j.event || j.message || ''); }
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

async function poll() {
  const turns = scanLog();
  const cfg = settings();
  const dbg = process.env.QQ_NOTIFY_DEBUG === '1';
  if (dbg) log(`巡检: 日志回合数=${Object.keys(turns).length} 阈值=${cfg.thresholdSec}s 失联=${cfg.stallMs / 60000}分 在途上限=${cfg.capMs / 60000}分`);
  const seen = new Set();

  for (const [tid, t] of Object.entries(turns)) {
    if (!t.sess) continue;
    const key = `${tid}:${t.sess.slice(5, 13)}`;
    seen.add(key);

    if (t.completed) {
      // —— 正常完成 → 达标则 ✅ ——
      const st0 = mem.notified[key];
      if (st0 === 'done' || st0 === 'skip' || st0 === 'failed' || st0 === 'nokey') continue;
      if (!t.started) { mem.notified[key] = 'skip'; saveMem(); continue; } // 起点不在可读日志范围内
      const durSec = (t.completed - t.started) / 1000;
      if (durSec < cfg.thresholdSec) { mem.notified[key] = 'skip'; saveMem(); continue; }
      const fails = mem.sendFail?.[key] || 0;
      if (fails >= 3) { mem.notified[key] = 'failed'; saveMem(); continue; }
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
      const r = await send(
        lines.join('\n'),
        ['✅ 任务完成（通知详情被过滤，请回 ZCode 查看）', `耗时：${formatDuration(durSec)}`, `工具调用：${t.tools}次`].join('\n'),
      );
      if (r === true) { mem.notified[key] = 'done'; if (mem.sendFail) delete mem.sendFail[key]; }
      else if (r === 'nokey') { mem.notified[key] = 'nokey'; }
      else { mem.sendFail = mem.sendFail || {}; mem.sendFail[key] = fails + 1; }
      saveMem();
    } else {
      // —— 已开始未完成：三种情形分级判定 ——
      // ① 失败信号（Turn failed 是该回合最后事件）→ 2 分钟宽限后即刻报警
      //    （SDK 重试期间 lastEvt 会回到 started，不算失败终态）
      // ② 在途（思考/长工具）→ 在途上限（默认30分钟）内不报，超限视为黑洞
      // ③ 无在途 + 沉默超失联阈值（默认5分钟）→ 报警
      const st0 = mem.notified[key];
      if (st0 === 'aborted' || st0 === 'nokey' || st0 === 'failed') continue;
      if (!t.lastTs) continue; // 该回合在日志中无自身活动记录，宁缺勿滥
      const silence = Date.now() - t.lastTs;
      const failFresh = t.failTs && t.failTs >= t.lastTs && (Date.now() - t.failTs) >= FAIL_GRACE_MS;
      const inFlightReq = t.reqS > t.reqC;   // 模型请求在途 = 思考/生成中，永不超时误报
      const inFlightTool = t.toolS > t.toolC; // 工具在途（长命令），受上限约束防黑洞
      if (dbg) log(`评估 ${tid.slice(5, 13)}: silence=${Math.round(silence / 1000)}s reqS=${t.reqS} reqC=${t.reqC} toolS=${t.toolS} toolC=${t.toolC} lastEvt=${t.lastEvt.slice(0, 30)} failFresh=${!!failFresh} inFlightReq=${inFlightReq} inFlightTool=${inFlightTool}`);
      if (!failFresh) {
        if (silence < cfg.stallMs) continue;               // 最近仍有活动
        if (inFlightReq) continue;                          // 思考/生成中：SDK 超时与失败事件会给终态
        if (inFlightTool && silence < cfg.capMs) continue;  // 长工具在途（上限防黑洞）
      }
      if (!ZC.zcodeProcessRunning(execSync)) continue; // 应用已关闭：不标记不报警，恢复后补报
      const fails = mem.sendFail?.[key] || 0;
      if (fails >= 3) { mem.notified[key] = 'failed'; saveMem(); continue; }
      const info = withDb(db => ({
        title: db ? ZC.dbSessionTitle(db, t.sess) : '',
        label: db ? ZC.dbLastPrompt(db, t.sess, Date.now()) : '',
      })) || {};
      const lines = ['⚠️ 任务中断'];
      if (info.title) lines.push(`对话：${sanitize(info.title).slice(0, 40)}`);
      if (info.label) lines.push(`任务：${sanitize(info.label).slice(0, 40)}`);
      lines.push(`已运行：${formatDuration((Date.now() - t.started) / 1000)}后失联`);
      lines.push('（回合未正常结束，请回 ZCode 查看）');
      const r = await send(
        lines.join('\n'),
        ['⚠️ 任务中断（详情被过滤，请回 ZCode 查看）', `已运行：${formatDuration((Date.now() - t.started) / 1000)}后失联`].join('\n'),
      );
      if (r === true) { mem.notified[key] = 'aborted'; if (mem.sendFail) delete mem.sendFail[key]; }
      else if (r === 'nokey') { mem.notified[key] = 'nokey'; }
      else { mem.sendFail = mem.sendFail || {}; mem.sendFail[key] = fails + 1; }
      saveMem();
    }
  }

  // 记忆清理：日志中已不见的回合逐出
  for (const key of Object.keys(mem.notified)) {
    if (!seen.has(key)) delete mem.notified[key];
  }
  for (const key of Object.keys(mem.sendFail || {})) {
    if (!seen.has(key)) delete mem.sendFail[key];
  }
  for (const key of Object.keys(mem.lastSeen || {})) {
    if (!seen.has(key)) delete mem.lastSeen[key];
  }
  saveMem();
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
      return { ok: false, msg: `打开/查询失败: ${e.message} → 适配层 findDbPath/db* 查询` };
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
      return { ok: false, msg: '计划任务丢失 → 在任意 ZCode 对话发一条消息触发重注册，或运行 schtasks 手动注册（见 README）' };
    }
  });

  console.log('\nqq-notify 自诊断（v1.1.1）');
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
