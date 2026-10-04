# qq-notify — ZCode 任务完成 QQ 通知插件

当你给 ZCode 派了一个活然后去干别的，它干完会主动到 QQ 上喊你回来。

一个 [ZCode](https://z.ai) 插件：回合耗时达到阈值（默认 1 分钟，可调）正常完成时发送"✅ 任务完成"；回合半路死掉（模型流断开等）时发送"⚠️ 任务中断"。纯 hook + 后台看门狗实现，AI 无需配合，不干扰正常对话。

> A ZCode plugin that notifies QQ (via Qmsg) when a conversation turn finishes normally — or dies halfway.

## 通知长这样

```
✅ 任务完成
项目：插件开发
任务：重构登录模块并补齐测试
耗时：5分20秒
工具调用：14次
📝 登录模块重构完成：抽出了 AuthService，补了 12 个单测…
```

回合半路死掉（如模型流断开）时，收到的是中断通知：

```
⚠️ 任务中断
任务：重构登录模块并补齐测试
已运行：12分40秒后失联
（回合未正常结束，请回 ZCode 查看）
```

## 特性

- **全对话覆盖**：通知基于 ZCode 运行日志而非 hook——老对话、SSH 对话、后台任务子会话一律适用，无需重启、无需重新绑定
- **阈值过滤**：单轮耗时超过阈值才通知，随口问答不打扰
- **内容丰富**：项目名、任务标签（你的 prompt 摘录）、耗时、工具调用次数、AI 结果摘要
- **防误报**：turnId 校验，回合被中断重发不会误报；多会话/多项目状态互相隔离
- **全局生效**：用户级安装后，所有 ZCode 会话自动生效
- **绝不添乱**：任何失败（断网、key 失效）都静默退出，不阻塞会话
- **内容自动清洗**：Qmsg 禁止 URL 和长数字串，脚本自动替换为"链接"和"…"

## 安装

### 第一步：开通 Qmsg 酱（一次性）

1. 打开 [qmsg.zendee.cn](https://qmsg.zendee.cn)，用 QQ 授权登录
2. 在控制台获取你的 **API Key**
3. 用 QQ 扫码添加 Qmsg 机器人为好友，并向机器人发送你的 API Key 完成绑定

### 第二步：安装插件

**方式一：插件市场直接添加本仓库（推荐）**

1. 打开 ZCode → 左侧「插件市场」→ 右上角「+ 新建」
2. 输入本仓库地址（`https://github.com/<你的用户名>/zcode-qq-notify`）
3. 在「个人」标签下找到 **Qq Notify**，点「安装」

**方式二：本地目录**

```bash
git clone https://github.com/<你的用户名>/zcode-qq-notify.git
```

然后 ZCode → 插件市场 →「+ 新建」→ 选择克隆出来的目录。

### 第三步：填入你的 API Key

二选一：

- **环境变量（推荐）**：设置系统环境变量 `QMSG_KEY` 为你的 key，重启 ZCode 生效
- **配置文件**：编辑插件安装目录下的 `config.json`，把 `qmsgKey` 换成你的 key

## 配置

`config.json`（每次 hook 触发时重新读取，改完即生效，无需重启会话）：

```json
{
  "qmsgKey": "你的 Qmsg API Key",
  "thresholdSeconds": 60,
  "stallMinutes": 5
}
```

环境变量（优先级高于 config.json；修改后需重启 ZCode）：

| 变量 | 作用 |
|---|---|
| `QQ_NOTIFY_THRESHOLD_SECONDS` | 通知阈值（秒），覆盖 `thresholdSeconds` |
| `QQ_NOTIFY_STALL_MINUTES` | 失联阈值（分钟），覆盖 `stallMinutes` |
| `QMSG_KEY` | Qmsg API Key，覆盖 `qmsgKey` |
| `QQ_NOTIFY_DRY_RUN=1` | 只打印不发送，测试用 |

**阈值说明**：按**单轮**计时——从你发出消息到 AI 回复结束的墙钟时长。AI 中途向你提问的等待时间不计入；跨多轮的长任务请自行把阈值调低。

## 工作原理

一个 Windows 计划任务 + 一个注册用 hook，纯脚本实现。**通知基于 ZCode 运行日志与会话数据库，与 hook 的会话绑定无关——老对话、SSH 对话、后台任务子会话一律覆盖：**

1. **计划任务（每分钟）** — 调起单次巡检 `watchdog.mjs`：扫描 ZCode 当日运行日志中的 `turn.started` / `turn.completed` 事件（回合生命周期在日志里有完整记录，与 hook 无关）
2. **✅ 任务完成** — `turn.completed` 且时长 ≥ 阈值 → 通知。对话名、任务标签、AI 摘要从会话数据库（db.sqlite）读取
3. **⚠️ 任务中断** — `turn.started` 后一直没等到完成、且该会话的日志沉默超过失联阈值（默认 5 分钟）→ 通知（每回合最多一次）
4. **UserPromptSubmit hook** — 只负责一件事：确保计划任务已注册（自愈式：插件路径/版本变化时自动重建）

巡检进程运行在 ZCode 之外（计划任务服务），不受会话结束影响。
依赖：ZCode、Node.js ≥ 22.5（node:sqlite）、能访问 `qmsg.zendee.cn`。

## 已知限制

- 计划任务注册依赖至少一次 hook 触发（任意对话发一条消息即完成自愈）；注册后持续覆盖所有会话
- 回合起点在昨日、完成在今天 0 点后的跨天回合不通知（罕见）
- **中断通知的延迟 = 失联阈值 + 至多 1 分钟巡检间隔**；会话在 ZCode 日志中查不到活动时不报警（宁缺勿滥）；ZCode 关闭期间不报警，恢复后补报
- Qmsg 酱限流：同一 key 每 5 秒 1 条、每日 500 条（看门狗内置 6 秒重试，撞限流可自愈）
- ⚠️ 不要把真实 API Key 提交到任何公开仓库；建议用 `QMSG_KEY` 环境变量

## License

[MIT](./LICENSE)
