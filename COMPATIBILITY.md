# 兼容契约（COMPATIBILITY.md）

本插件依赖 ZCode 的 7 个外部接口。**所有接触点集中在 `hooks/zcode-adapter.mjs`**，业务代码不直接引用任何 ZCode 路径/事件名/表结构。

## ZCode 更新后插件失效怎么办（三步定位）

```bash
node ~/.qq-notify/watchdog.mjs --doctor
```

1. 运行自诊断，看哪一项 ❌（每项都标注 COMPAT 编号）
2. 对照下表找到该编号的契约与代码位置
3. 只改 `zcode-adapter.mjs` 对应段落，改完再跑一次 `--doctor` 确认

## 契约清单

| 编号 | 依赖 | 当前预期 | 代码位置 | 失效症状 | 修复方式 |
|---|---|---|---|---|---|
| COMPAT-1 | 数据根目录 | `~/.zcode/cli` | `ZCODE_DIR_CANDIDATES` | 找不到日志和数据库，doctor 两项失败 | 追加新路径候选；或设环境变量 `QQ_NOTIFY_ZCODE_DIR` |
| COMPAT-2 | 日志目录与文件名 | `<根>/log/zcode-YYYY-MM-DD.jsonl` | `findLogDir` / `logFilePaths` | 找不到日志文件 | 追加目录候选 / 修改文件名模式 |
| COMPAT-3 | 事件名 | `turn.started` / `turn.completed` / `model.request.started` / `model.request.completed` / `tool.call.started` / `tool.call.completed` | `EVENTS` 表 | 日志有内容但 0 个回合被识别（完成/中断通知全部消失） | 在对应数组追加新事件名（旧名保留兼容） |
| COMPAT-4 | 日志行字段 | `timestamp`(ISO) / `sessionId` / `turnId` / `context.toolCallCount` | `extract*` 函数组 | 回合识别异常（时长/会话错乱） | 在 extract 函数追加字段别名 |
| COMPAT-5 | 数据库位置 | `<根>/db/db.sqlite` | `findDbPath` | 通知缺少"对话/任务/摘要"行 | 追加路径候选 |
| COMPAT-6 | 数据库表结构 | `session(id,title)` / `input_history(session_id,text,time_created)` / `message(session_id,data,sequence)`（data 含 `{role,text|parts,time}`）/ `turn_usage(turn_id,status,cancelled_by_user)` | `dbSessionTitle` / `dbLastPrompt` / `dbLastAssistantText` / `dbTurnStatus` | 通知缺少素材行（发送不受影响，静默降级）；**手动停止将与自然失败无法区分（手动停止也会报警）** | 修改对应查询与解析 |
| COMPAT-7 | 进程名 | `ZCode.exe` | `PROCESS_PATTERNS` | ⚠️ 中断报警被抑制（完成通知不受影响） | 追加进程名正则 |

## 不属于 ZCode 依赖的部分（不会被 ZCode 更新破坏）

- **计划任务**：指向 `~/.qq-notify/run-hidden.vbs`（版本无关的稳定目录）。插件更新后，任意对话发一条消息即触发 hook 自动同步最新脚本并校正任务
- **配置**：运行时唯一来源是 `~/.qq-notify.json`（+环境变量），插件目录的 config.json 只作首次引导默认值
- **通知通道**：Qmsg 酱 HTTP API（含违规自愈），与 ZCode 无关

## 环境变量总表（全部可选，优先级最高）

| 变量 | 作用 |
|---|---|
| `QQ_NOTIFY_ZCODE_DIR` | 手动指定 ZCode 数据根目录（COMPAT-1 失效时的应急通道）|
| `QQ_NOTIFY_LOG_DIR` / `QQ_NOTIFY_DB_PATH` | 单独覆盖日志目录 / 数据库路径（测试用）|
| `QMSG_KEY` | Qmsg API Key |
| `QQ_NOTIFY_THRESHOLD_SECONDS` | 完成通知阈值（秒）|
| `QQ_NOTIFY_STALL_MINUTES` | 失联阈值（分钟）|
| `QQ_NOTIFY_INFLIGHT_CAP_MINUTES` | 在途上限（分钟）|
| `QQ_NOTIFY_DRY_RUN=1` | 只打印不发送 |

## 运行时可观测性

- 运行日志：`~/.qq-notify/watchdog.log`（自动滚动保留 128KB，记录每次发送与回执）
- 状态账本：`%TEMP%\qq-notify-watchdog\memory.json`（done/skip/aborted/nokey/failed/sendFail）
- 自诊断：`node ~/.qq-notify/watchdog.mjs --doctor`
