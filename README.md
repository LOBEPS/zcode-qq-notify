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

两个 hook + 一个后台看门狗，纯脚本实现：

1. **UserPromptSubmit** — 记录回合开始时间、turnId、任务标签（prompt 摘录）、会话记录路径，状态按会话 ID 隔离存放在系统临时目录；顺带拉起看门狗（幂等，后台运行，不阻塞会话）
2. **Stop** — 回合正常结束时核对 turnId（防止被中断/重发的旧回合误报），时长达到阈值则调用 Qmsg API 发送"✅ 任务完成"
3. **看门狗（watchdog.mjs）** — 单例后台进程，每 30 秒检查各回合的会话记录是否停止更新：状态残留且停更超过失联阈值（默认 5 分钟）→ 发送"⚠️ 任务中断"（每回合最多一次）。ZCode 已关闭时不报警；15 分钟无未决回合自动退出，下次回合开始时自动拉起

依赖：ZCode（支持 hooks 的版本）、Node.js ≥ 18、能访问 `qmsg.zendee.cn`。

## 已知限制

- **hook 在会话创建时绑定**：安装插件后，**新对话**立即生效；**安装前就已打开的旧对话**需要重启 ZCode（保持这些对话处于打开状态，重启后会被恢复并重新加载 hooks）。之后新建的对话无需任何操作
- hook 注册在会话启动时快照：安装/卸载/更新插件后需要新会话（或重启 ZCode）才生效；但 `config.json` 的 key/阈值是每次触发时读取的，改完即生效
- **中断通知有约 5 分钟的天然延迟**（要等失联判定成立）；个别会话拿不到会话记录路径时不报警（宁缺勿滥）；ZCode 关闭期间不报警，重新打开后补报
- ZCode 桌面版默认工作区拿不到真实项目名，通知中以「任务：prompt 摘录」标识来源
- Qmsg 酱限流：同一 key 每 5 秒 1 条、每日 500 条（看门狗内置 6 秒重试，撞限流可自愈）
- ⚠️ 不要把真实 API Key 提交到任何公开仓库；建议用 `QMSG_KEY` 环境变量

## License

[MIT](./LICENSE)
