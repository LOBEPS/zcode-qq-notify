# qq-notify — ZCode 任务完成 QQ 通知插件

当一轮 ZCode 对话达到通知条件（视为任务完成）时，通过 [Qmsg 酱](https://qmsg.zendee.cn)给你的 QQ 发送私聊通知。

## 通知长什么样

```
✅ 任务完成
项目：插件开发
任务：重构登录模块并补齐测试
耗时：5分20秒
工具调用：14次
📝 登录模块重构完成：抽出了 AuthService，补了 12 个单测…
```

（`default` 工作区下省略项目行；AI 最终回复为空时省略摘要行）

## 工作原理

两个 hook，纯脚本实现，AI 无需配合：

1. **UserPromptSubmit** — 记录回合开始时间、turnId、任务标签（prompt 摘录），状态按会话 ID 隔离存放在系统临时目录
2. **Stop** — 回合结束时核对 turnId（防止被中断/重发的旧回合误报），时长达到阈值则调用 Qmsg API 发送通知

任何失败（断网、Qmsg 故障、key 失效）都静默退出，绝不阻塞会话。

## 配置

`config.json`（每次 hook 触发时重新读取，改完即生效，无需重启会话）：

```json
{
  "qmsgKey": "你的 Qmsg API Key",
  "thresholdSeconds": 300
}
```

环境变量（优先级高于 config.json；修改后需重启 ZCode 生效）：

| 变量 | 作用 |
|---|---|
| `QQ_NOTIFY_THRESHOLD_SECONDS` | 通知阈值（秒），覆盖 `thresholdSeconds` |
| `QMSG_KEY` | Qmsg API Key，覆盖 `qmsgKey` |
| `QQ_NOTIFY_DRY_RUN=1` | 只打印不发送，测试用 |

阈值判定为**单轮计时**：从你发出消息到 AI 回复结束的墙钟时长。跨轮等待（AI 中途向你提问）不计入。

## 使用前提（Qmsg 酱侧）

1. QQ 授权登录 qmsg.zendee.cn，控制台获取 API Key
2. QQ 扫码添加 Qmsg 机器人为好友，向机器人发送 API Key 完成绑定

限流：同一 Key 每 5 秒 1 条、每日 500 条；内容检测禁止 URL 和长数字串（本插件已自动把 URL 替换为"链接"、7 位以上数字替换为"…"）。

## 已知限制

- hook 配置在**会话启动时快照**：安装/卸载插件、改 hooks 配置后，需要新会话（或重启 ZCode）才生效；但 `config.json` 的 key/阈值是每次触发时读取的，改完即生效
- 桌面版默认工作区（`workspace\default`）拿不到真实项目名，通知里以"任务：prompt 摘录"标识来源

## 文件结构

```
qq-notify/
├── .zcode-plugin/plugin.json   # 插件清单
├── hooks/hooks.json            # hook 注册（UserPromptSubmit + Stop）
├── hooks/notify.mjs            # 核心脚本（Node ≥ 18）
└── config.json                 # key 与阈值
```
