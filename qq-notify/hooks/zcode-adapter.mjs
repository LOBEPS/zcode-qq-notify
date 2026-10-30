// zcode-adapter.mjs — ZCode 版本适配层
// ═══════════════════════════════════════════════════════════════════
// 本文件是插件与 ZCode 之间的唯一接触面。ZCode 版本更新导致插件失效时，
// 运行 `node watchdog.mjs --doctor` 即可定位失效的 COMPAT 条目，
// 然后到本文件对应 [COMPAT-n] 处修改。契约详情见 COMPATIBILITY.md。
// 业务代码（watchdog.mjs）不允许直接引用任何 ZCode 路径/事件名/表结构。
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// [COMPAT-1] ZCode 数据根目录（含日志与数据库）的候选位置，按优先级排列。
// ZCode 更换安装/数据布局时在此追加候选路径。
const ZCODE_DIR_CANDIDATES = [
  () => process.env.QQ_NOTIFY_ZCODE_DIR || '',      // 手动覆盖，最高优先
  () => path.join(os.homedir(), '.zcode', 'cli'),   // 3.x 已知布局
  () => path.join(os.homedir(), '.zcode'),          // 更浅布局兜底
];

export function findZcodeDir() {
  for (const cand of ZCODE_DIR_CANDIDATES) {
    const p = cand();
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

// [COMPAT-2] 运行日志目录与文件名模式。
export function findLogDir() {
  if (process.env.QQ_NOTIFY_LOG_DIR) return process.env.QQ_NOTIFY_LOG_DIR;
  const d = findZcodeDir();
  if (!d) return null;
  for (const rel of ['log', 'logs']) {
    const p = path.join(d, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

export function logFilePaths() {
  const dir = findLogDir();
  if (!dir) return [];
  // 全保留期扫描：今天+昨天+更早。长寿命回合（SSH 会话的数天长任务）的
  // turn.started 事件可能在数天前的日志里——只扫两天会漏掉它们的完成通知。
  const names = fs.readdirSync(dir)
    .filter(f => /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .sort();
  return names.map(name => path.join(dir, name));
}

// [COMPAT-3] 事件名契约。ZCode 重命名事件时，在对应数组里追加新名即可。
export const EVENTS = {
  turnStarted: ['turn.started'],
  turnCompleted: ['turn.completed'],
  reqStarted: ['model.request.started'],
  reqCompleted: ['model.request.completed'],
  toolStarted: ['tool.call.started'],
  toolCompleted: ['tool.call.completed'],
};

export function eventKind(name) {
  for (const [kind, aliases] of Object.entries(EVENTS)) {
    if (aliases.includes(name)) return kind;
  }
  return null;
}

// [COMPAT-4] 日志行字段名。ZCode 改字段名时在此追加别名。
export function extractTurnId(j) { return j.turnId || j.turn_id || ''; }
export function extractSessionId(j) { return j.sessionId || j.session_id || ''; }
export function extractTimestamp(j) { return Date.parse(j.timestamp || j.time || ''); }
export function extractToolCount(j) { return j.context?.toolCallCount ?? j.context?.tool_count ?? 0; }

// [COMPAT-5] 会话数据库位置。
export function findDbPath() {
  if (process.env.QQ_NOTIFY_DB_PATH) return process.env.QQ_NOTIFY_DB_PATH;
  const d = findZcodeDir();
  if (!d) return null;
  for (const rel of ['db/db.sqlite', 'db.sqlite', 'database/db.sqlite']) {
    const p = path.join(d, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// [COMPAT-6] 数据库表结构与查询。ZCode 改 schema 时只改这里。
// 传入已打开的 DatabaseSync 句柄，全部失败返回空值（通知仍可发出，只是缺素材）。
export function dbSessionTitle(db, sid) {
  try {
    const r = db.prepare('SELECT title FROM session WHERE id = ?').get(sid);
    return String(r?.title || '');
  } catch { return ''; }
}

// 回合权威状态（turn_usage 表）：手动停止(cancelled)与自然失败(error)的唯一区分来源。
// 日志里两者都记 turn.failed 无法区分，必须查库。
export function dbTurnStatus(db, tid) {
  try {
    const r = db.prepare('SELECT status, cancelled_by_user FROM turn_usage WHERE turn_id = ?').get(tid);
    if (!r) return null;
    return {
      status: String(r.status || ''),
      cancelled: r.status === 'cancelled' || !!r.cancelled_by_user,
    };
  } catch { return null; }
}

export function dbLastPrompt(db, sid, ts) {
  try {
    const r = db.prepare(
      'SELECT text FROM input_history WHERE session_id = ? AND time_created <= ? ORDER BY time_created DESC LIMIT 1',
    ).get(sid, ts);
    return String(r?.text || '');
  } catch { return ''; }
}

export function dbLastAssistantText(db, sid, ts) {
  try {
    const rows = db.prepare(
      'SELECT data FROM message WHERE session_id = ? ORDER BY sequence DESC LIMIT 8',
    ).all(sid);
    for (const r of rows) {
      try {
        const d = JSON.parse(r.data);
        const created = d?.time?.completed || d?.time?.created || 0;
        if (d?.role !== 'assistant') continue;
        if (created && created > ts) continue;
        let text = '';
        if (typeof d?.text === 'string') text = d.text;
        else if (Array.isArray(d?.parts)) text = d.parts.map(p => p?.text || '').join(' ');
        else if (Array.isArray(d?.content)) text = d.content.filter(p => p?.type === 'text').map(p => p?.text || '').join(' ');
        if (text.trim()) return text;
      } catch { continue; }
    }
  } catch { /* schema 变化时静默降级 */ }
  return '';
}

// [COMPAT-7] ZCode 进程检测（用于"应用已关闭不报警"判断）。
// 进程名变更时在此追加。检测失败按运行中处理（宁可误报不可漏报）。
const PROCESS_PATTERNS = [/zcode\.exe/i];
export function zcodeProcessRunning(execSyncFn) {
  try {
    const out = execSyncFn('tasklist /NH', { encoding: 'utf8', timeout: 8000, windowsHide: true });
    return PROCESS_PATTERNS.some(re => re.test(out));
  } catch {
    return true;
  }
}
