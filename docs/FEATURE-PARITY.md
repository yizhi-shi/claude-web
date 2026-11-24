# VSCode Claude Code 插件能力对照

> 状态: current
> 最后核对: 2026-11-24
> 事实源: 本机 `anthropic.claude-code` 插件 2.1.330、CLI 2.1.330、Agent SDK 0.3.330
> 关联: [架构](ARCHITECTURE.md) · [Roadmap](ROADMAP.md)

## 对照表

| 能力 | VSCode 插件 | Web 控制台 | 说明 |
|---|---|---|---|
| 对话流式输出 | ✅ | ✅ | `includePartialMessages` + `assistant.delta` |
| Markdown / 代码高亮 | ✅ | ✅ | markdown-it + highlight.js |
| 工具调用卡片 | ✅ | ✅ | 可折叠，命令/结果可复制 |
| 文件编辑 diff | ✅ | ✅ | Edit/Write/MultiEdit 统一 diff |
| 权限审批 | ✅ | ✅ | 允许一次 / 本次会话 / 拒绝；超时拒绝 |
| 权限模式切换 | ✅ | ✅ | default / acceptEdits / plan / auto / dontAsk / bypass |
| 会话历史与续聊 | ✅ | ✅ | 扫描 `~/.claude/projects`，`resume` |
| 会话列表状态 | ✅ | ✅ | 运行中 / 等待审批 / 空闲 / 停止 / 异常 |
| 后台任务/子代理状态 | ✅ | ✅ | task_started/progress/updated/notification |
| 上下文用量 / 费用 | ✅ | ✅ | `getContextUsage` + `total_cost_usd` |
| 上下文压缩提示 | ✅ | ✅ | status / compact_boundary 事件 |
| 斜杠命令 | ✅ | ✅ | init 的 `slash_commands` + 内置菜单 |
| Skills | ✅ | ✅ | init 的 `skills`，按 `/名字` 插入 |
| `@` 文件引用 | ✅ | ✅ | `rg --files` 搜索，插入相对路径 |
| Plan mode | ✅ | 🟡 | 可选择 plan 模式；计划确认交互待专项验证 |
| 交互式提问（AskUserQuestion） | ✅ | 🟡 | 工具可调用；当前 Web 端返回“未回答”，问答面板列为后续 |
| 图片粘贴/附件 | ✅ | ✅ | 粘贴/拖拽/选择文件；图片走 image content block，小文本内联，其他文件按路径引用 |
| 旁问（`/btw`） | ✅ | ✅ | 运行中基于当前上下文 fork 回答；禁工具、不写入主对话、不新增 Claude 会话文件 |
| 检查点 / 回退 | ✅ | ⏳ | roadmap；SDK 有 rewind 控制面，需 UI |
| 终端集成 | ✅ | ⏳ | 刻意不做；避免把控制台变成无结构终端 |
| 文件树/编辑器 | ✅（部分版本） | ⏳ | 刻意后置；保持核心精简 |
| Git 面板 | 第三方/插件 | ⏳ | 后置 |
| MCP / 插件管理 | ✅ | ⏳ | 后置；对话已能使用已配置的 MCP |
| 多模型供应商 | 取决于 CLI | ✅ | 沿用本机 `~/.claude/settings.json`/环境变量 |
| 手机/平板 | ❌ | ✅ | 响应式 + 抽屉侧栏 + 底部输入区 |
| 亮/暗主题 | ✅ | ✅ | CSS token 切换，本地记忆 |
| 页面刷新不中断 | ❌（IDE 重载会断） | ✅ | 服务端常驻 + 事件回放 |
| 多标签同时附着 | ❌ | ✅ | 同一会话多 WebSocket 订阅 |
| 语音输入 | ❌（插件有语音相关能力但非通用） | ✅（点击听写，三种实时） | Gemini Live / OpenAI Realtime / OpenAI 分段 / 火山引擎流式 / 浏览器；配置在设置页，停止后立即收尾 |

## 升级跟进流程

1. 更新 VSCode 插件或 CLI 后运行：
   ```bash
   node scripts/check-upstream.mjs
   claude --help
   ```
2. 对照插件 `package.json` 与 `extension.js` 的协议关键字（只做能力核对，不复制代码/素材）：
   ```bash
   grep -rhoE -- '--[a-z-]+|can_use_tool|control_request|--input-format|--include-partial-messages' \
     ~/.vscode-server/extensions/anthropic.claude-code-*/extension.js | sort -u
   ```
3. 对照 SDK 类型：
   ```bash
   grep -nE 'export declare type (SDKMessage|CanUseTool|PermissionResult)|new SDK message|getContextUsage|supportedCommands' \
     node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts
   ```
4. 若新增事件/控制方法：
   - 在 `server/src/types.ts` 增加 UI 事件；
   - 在 `runtime.ts` 映射；
   - 在 `Chat.vue` / `MessageItem.vue` 渲染；
   - 更新本矩阵与 `docs/ARCHITECTURE.md`。
5. 回归：一次文本回合、一次 Write 审批 + 页面刷新、一次长 Bash 实时状态、一次 `/` 与 `@` 菜单。

**边界**：这是独立实现，不复用插件的 webview 代码或图片资源；仅依据 CLI/SDK 的公开协议与 UX 观察。
