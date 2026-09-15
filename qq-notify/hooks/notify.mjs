// qq-notify — ZCode 任务完成 QQ 通知（Qmsg 酱通道）
// 用法: node notify.mjs <user-prompt-submit|stop>
// 环境变量:
//   QQ_NOTIFY_THRESHOLD_SECONDS  通知阈值（秒），优先级最高
//   QMSG_KEY                     Qmsg API key，优先级高于 config.json
//   QQ_NOTIFY_DRY_RUN=1          只打印不发送（测试用）
// 任何失败都静默退出 0，绝不阻塞会话。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MODE = process.argv[2] || '';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.join(os.tmpdir(), 'qq-notify-state');
const SESSION = (process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || 'unknown')
  .replace(/[^a-zA-Z0-9._-]/g, '_');
const STATE_FILE = path.join(STATE_DIR, `session-${SESSION}.json`);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

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

function thresholdSeconds() {
  const envV = Number(process.env.QQ_NOTIFY_THRESHOLD_SECONDS);
  if (Number.isFinite(envV) && envV > 0) return envV;
  const cfgV = Number(loadConfig().thresholdSeconds);
  if (Number.isFinite(cfgV) && cfgV > 0) return cfgV;
  return 600;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function saveState(st) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st));
}
function clearState() {
  try { fs.rmSync(STATE_FILE, { force: true }); } catch { /* 忽略 */ }
}
function sweepOldStates() {
  try {
    for (const f of fs.readdirSync(STATE_DIR)) {
      const p = path.join(STATE_DIR, f);
      if (Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) fs.rmSync(p, { force: true });
    }
  } catch { /* 忽略 */ }
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

// Qmsg 内容检测拦截 URL 和长数字串，摘要与任务标签必须先清洗
function sanitize(text) {
  return text
    .replace(/https?:\/\/\S+/g, '链接')
    .replace(/\d{7,}/g, '…')
    .replace(/[#*`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

// Stop 事件的 stdin 自带 AI 最终回复全文（responseText），取开头作摘要
function extractSummary(stdin) {
  const text = String(
    stdin.responseText || stdin.last_assistant_message || stdin.responsePreview || '',
  );
  return text.trim() ? sanitize(text) : '';
}

async function send(text) {
  const key = process.env.QMSG_KEY || loadConfig().qmsgKey;
  if (!key) {
    console.error('qq-notify: 未配置 QMSG_KEY 或 config.json 的 qmsgKey');
    return;
  }
  if (process.env.QQ_NOTIFY_DRY_RUN === '1') {
    console.error(`qq-notify: DRY RUN 未发送，消息内容:\n${text}`);
    return;
  }
  try {
    const res = await fetch(
      `https://qmsg.zendee.cn/v3/send/${key}?msg=${encodeURIComponent(text)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const body = await res.json().catch(() => ({}));
    console.error(`qq-notify: Qmsg ${res.status} success=${body.success}`);
  } catch (e) {
    console.error(`qq-notify: 发送失败 ${e?.cause?.message || e?.message || e}`);
  }
}

async function onStop(stdin) {
  const st = loadState();
  if (!st) {
    console.error('qq-notify: 无本轮状态，跳过');
    return;
  }
  const inTurnId = stdin.turnId || stdin.turn_id;
  if (st.turnId && inTurnId && st.turnId !== inTurnId) {
    // 该 Stop 属于已被新回合取代的旧回合（如用户中断重发），不计入
    console.error('qq-notify: turnId 不匹配，跳过');
    return;
  }
  const dur = (Date.now() - st.start) / 1000;
  const th = thresholdSeconds();
  if (dur < th) {
    console.error(`qq-notify: 回合 ${Math.round(dur)}s 未达阈值 ${th}s，不通知`);
    return;
  }
  const lines = ['✅ 任务完成'];
  const proj = projectName();
  if (proj && proj !== 'default') lines.push(`项目：${proj}`);
  if (st.prompt) lines.push(`任务：${st.prompt}`);
  lines.push(`耗时：${formatDuration(dur)}`);
  lines.push(`工具调用：${stdin.toolCallCount ?? 0}次`);
  const summary = extractSummary(stdin);
  if (summary) lines.push(`📝 ${summary}`);
  await send(lines.join('\n'));
}

async function main() {
  const stdin = await readStdin();
  if (MODE === 'user-prompt-submit') {
    saveState({
      start: Date.now(),
      turnId: stdin.turnId || stdin.turn_id || '',
      prompt: sanitize(stdin.prompt || '').slice(0, 40),
    });
    sweepOldStates();
  } else if (MODE === 'stop') {
    await onStop(stdin);
    clearState();
  }
}

main().then(() => process.exit(0)).catch(e => {
  console.error(`qq-notify: ${e?.message || e}`);
  process.exit(0);
});
