// qq-notify 投递验证器 — 工作流判定工具
// 用法: node verify-notify.mjs <sessionId>
// 流程:
//   1. 在今日+昨日日志中查找该会话最新的 turn.completed
//   2. 触发一次看门狗巡检（若被计划任务实例占用则跳过——下个 tick 会处理）
//   3. 在 watchdog.log 中查找该回合完成之后的发送记录（msgId + 回执）
//   4. 向 Qmsg 查询最新一条相关 msgId 的投递回执
// 输出 JSON: { turnCompletedAt, watchdogSent, msgId, receipt, delivered, evidence }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const sid = process.argv[2] || '';
const LOG_DIR = process.env.QQ_NOTIFY_LOG_DIR || path.join(os.homedir(), '.zcode', 'cli', 'log');
const WLOG = path.join(os.homedir(), '.qq-notify', 'watchdog.log');
const WD = process.env.QQ_NOTIFY_WATCHDOG_PATH || path.join(os.homedir(), '.qq-notify', 'watchdog.mjs');
const KEY = process.env.QQ_NOTIFY_TEST_KEY || (() => {
  try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.qq-notify.json'), 'utf8')).qmsgKey || ''; } catch { return ''; }
})();

// 全保留期日志（系统时钟在这台机器上会跳变，日期窗口不可靠——按文件扫描全部保留期日志）
function dayFiles() {
  try {
    return fs.readdirSync(LOG_DIR)
      .filter(f => /^zcode-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .map(f => path.join(LOG_DIR, f));
  } catch { return []; }
}

function latestTurnCompleted() {
  let last = 0;
  for (const p of dayFiles()) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.includes('"turn.completed"') || !line.includes(sid)) continue;
      try { const j = JSON.parse(line); const t = Date.parse(j.timestamp); if (Number.isFinite(t) && t > last) last = t; } catch { /* 跳过 */ }
    }
  }
  return last;
}

function watchdogSendsSince(ts) {
  // watchdog.log 三种格式：
  //   v1.3.1+: "… 发送 msgId=X 回执=Y"
  //   v1.2.0+: "… 回执 X = Y"
  //   测试:     "… [FAKE] 发送#N: …"
  const out = [];
  try {
    for (const line of fs.readFileSync(WLOG, 'utf8').split('\n')) {
      const tm = line.match(/^(2026-\d+-\d+T[\d:.]+Z)/);
      if (!tm || Date.parse(tm[1]) < ts) continue;
      let m = line.match(/ 发送 msgId=(\S+) 回执=(-?\d+)$/);
      if (m) { out.push({ msgId: m[1], receipt: Number(m[2]), at: tm[1] }); continue; }
      m = line.match(/ 回执 (\S+) = (-?\d+)$/);
      if (m) { out.push({ msgId: m[1], receipt: Number(m[2]), at: tm[1] }); continue; }
      if (/FAKE.*任务完成/.test(line)) out.push({ msgId: 'fake', receipt: 1, at: tm[1] });
    }
  } catch { /* 无日志 */ }
  return out;
}

function qmsgStatus(msgId) {
  if (!KEY || !msgId) return null;
  try {
    const out = execSync(
      `curl -s "https://qmsg.zendee.cn/v3/msg/status/${KEY}?msgId=${msgId}"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    return Number(JSON.parse(out).data);
  } catch { return null; }
}

async function main() {
  const completedAt = latestTurnCompleted();
  if (!completedAt) {
    console.log(JSON.stringify({ turnCompletedAt: null, watchdogSent: false, msgId: null, receipt: null, delivered: false, evidence: '全部保留期日志中无该会话的 turn.completed 事件' }));
    return;
  }
  // 触发一次巡检（若与计划任务实例撞锁则跳过——下一个 tick 兜底）
  try { execSync(`node "${WD}" --once`, { timeout: 120000, windowsHide: true, stdio: 'ignore' }); } catch { /* 忽略 */ }
  const sends = watchdogSendsSince(completedAt - 60000); // 完成前 1 分钟内的发送也算（时钟偏差容忍）
  const last = sends[sends.length - 1] || null;
  const receipt = last ? qmsgStatus(last.msgId) : null;
  const delivered = (last && (last.receipt === 1 || receipt === 1)) || receipt === 1;
  console.log(JSON.stringify({
    turnCompletedAt: new Date(completedAt).toISOString(),
    watchdogSent: sends.length > 0,
    msgId: last?.msgId || null,
    receipt: receipt ?? last?.receipt ?? null,
    delivered,
    evidence: `sends=${sends.length} 最近回执=${receipt ?? last?.receipt ?? '无'}`,
  }));
}

main().catch(e => { console.log(JSON.stringify({ error: String(e?.message || e), delivered: false })); });
