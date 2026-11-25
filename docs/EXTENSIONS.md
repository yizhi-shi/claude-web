# MCP / 子代理 / 插件：Web 管理范围与取舍

> 状态: current
> 最后核对: 2026-11-24
> 事实源: Claude Code CLI 2.1.330、`@anthropic-ai/claude-agent-sdk` 0.3.330、`server/src/runtime.ts`、`server/src/http.ts`、`web/src/views/Chat.vue`
> 关联: [架构](ARCHITECTURE.md) · [核心实现](IMPLEMENTATION.md) · [功能对照](FEATURE-PARITY.md)

## 结论

CLI 的扩展管理命令大致分三类。我们只把**会影响当前会话工具可用性、且 SDK 有安全接口**的部分搬到 Web：

| 能力 | 是否有必要做 Web 管理 | 本期决定 |
|---|---|---|
| MCP 服务器状态 | **必要**：连接失败/需要认证会直接导致工具不可用 | ✅ 只读状态 + 重连 + 当前会话启停 |
| MCP 添加/编辑/删除/认证 | 不必要且高风险：涉及命令、env、headers、token，认证是交互式终端流程 | ❌ 仍在 CLI/配置文件中完成 |
| 子代理列表 | **有价值**：用户需要知道有哪些 agent、模型和用途 | ✅ 只读展示 |
| 子代理创建/编辑 | 不必要：本质是编辑 `.claude/agents/*.md`，属于文件编辑面 | ❌ 仍由 CLI/编辑器完成 |
| 插件市场/安装/更新/启用 | 不必要：供应链与权限风险高，SDK 没有安装 API，CLI 交互式 | ❌ 跳过 |
| Hooks 编辑 | 不必要且高风险：会影响所有工具调用；SDK 没有读取/管理 API | ❌ 跳过 |
| 权限规则编辑器 | 部分需要，但当前 Web 已有权限模式；细粒度 allow/deny 规则后续再评估 | ⏳ 后续 |
| `/output-style`、`/statusline`、`/vim`、`/terminal-setup`、`/ide`、`/login`、`/logout`、`/doctor` | 终端/IDE/诊断专用，Web 上下文不适用 | ❌ 跳过，synthetic 输出显示为系统消息 |
| `/add-dir` | 已有「设置 → 工作区目录」，不需要重复 | ✅ 已由设置页覆盖 |
| `/model`、`/context`、`/usage`、`/status`、`/config` | 已做 Web 原生面板 | ✅ 0.8.1 |

一句话：**MCP 状态/重连/启停 + 子代理只读列表值得做；完整的 MCP、Agent、Plugin、Hook 管理器不做。**

## 为什么

### MCP：状态比编辑更重要

MCP 服务器的价值在于工具是否真的连上。常见故障是：

- 服务器进程启动失败；
- 需要 OAuth/认证；
- 连接 pending 或断线；
- 被当前会话停用。

这些只需要 `mcpServerStatus()`、`toggleMcpServer()`、`reconnectMcpServer()` 三个 SDK 能力，风险低，而且都作用于当前会话。添加/编辑服务器则要处理命令、env、HTTP headers、token 和交互式认证，属于配置文件和终端；Web 端硬做会把 secret 管理和供应链风险引进来。

### 子代理：只读列表足够

`supportedAgents()` 可以列出当前会话可用的子代理名称、描述和模型。这解决了“我现在能用哪些 agent”的发现问题。创建/编辑 agent 本质是写 Markdown 文件，Web 端没有必要再做一个文件编辑器；用户可以在项目 `.claude/agents/` 或 `~/.claude/agents/` 中维护。

### 插件与 Hooks：明确跳过

- 插件安装/市场/更新涉及下载、供应链、权限和信任提示；SDK 只提供 `reloadPlugins()`（重载已安装插件，返回当前列表），没有安装/卸载 API。Web 端强行管理会变成第二个 CLI。
- Hooks 会影响每一个工具调用，写错可能让会话不可用；当前没有安全的列表/编辑 API。保持 CLI 管理。
- `/reload-plugins` 也不在 Web 里自动触发：重载可能改变工具列表和 prompt cache，影响正在运行的回合；需要时由用户在 CLI 执行。

## 实现

### API

```http
GET  /api/sessions/:id/extensions
POST /api/sessions/:id/mcp/toggle      { name, enabled }
POST /api/sessions/:id/mcp/reconnect   { name }
```

`GET /extensions` 返回：

```json
{
  "available": true,
  "mcpServers": [
    {
      "name": "echo-test",
      "status": "connected",
      "scope": "user",
      "source": "user",
      "serverName": "echo-test",
      "serverVersion": "1.0.0",
      "tools": [{ "name": "echo", "description": "..." }]
    }
  ],
  "agents": [
    { "name": "Explore", "description": "…", "model": "inherit" }
  ]
}
```

**不会返回** MCP 的 `config`、`env`、HTTP headers、命令路径或 token；只映射安全字段。工具只保留名字、描述和 `readOnly`/`destructive` 标注。

### 服务端

`ClaudeRuntime.extensions()`：

- 运行中才返回 `available: true`；
- `Promise.allSettled([mcpServerStatus(), supportedAgents()])`，一个失败不影响另一个；
- `mapMcpStatus()` / `mapAgentInfo()` 做白名单映射和长度截断；
- 状态值只允许 `connected/failed/needs-auth/pending/disabled`。

`toggleMcpServer()` / `reconnectMcpServer()` 校验名称后在当前 `Query` 上调用 SDK；HTTP 路由捕获错误并以 400 返回，同时写 audit。

### 前端

会话设置新增 **扩展** tab（`/mcp`、`/agents`、`/list-agents` 打开）：

- MCP 卡片：状态点、名称、scope/source、server 版本、工具数、前 4 个工具名、错误、重连/停用/启用；
- `needs-auth` 显示“请在终端运行 /mcp 完成登录”；
- 子代理卡片：名称、模型、描述；
- 刷新按钮；
- 明确提示插件市场/hooks/MCP 认证仍由 CLI 管理。

`/mcp` 或 `/agents` 带参数时仍打开面板，并提示添加/认证等子命令需要在终端执行。

## 安全边界

- 不把 MCP config/env/headers/命令路径发给浏览器；
- 不写 `~/.claude.json`、`.mcp.json`、settings 或 agent 文件；
- 启停只作用于当前运行时/SDK Query，不修改全局配置；
- 服务器名称只作为 SDK 参数，不拼接文件路径；
- 错误文本会截断到 500 字符后展示，仍可能包含服务端返回的 URL/路径，属于已登录用户可见的诊断信息；
- 认证流程不在 Web 伪造；需要认证时引导到终端。

## 验证

本地 smoke 使用隔离 HOME、一个临时 stdio MCP 服务器（`echo` 工具）和 `test-agent`：

- `GET /extensions` 返回 `echo-test` 为 connected，工具列表包含 `echo`；
- 返回 JSON 不包含 MCP 命令路径；
- toggle 停用/启用、reconnect 均成功；
- Chrome 中输入 `/mcp` 打开扩展 tab，状态显示已连接，UI 停用/启用后恢复；子代理列表可见；
- 构建、附件和 Web 原生命令测试回归通过。

## 已知限制

- MCP 认证仍必须去终端执行 `/mcp`；
- MCP 添加/编辑/删除不提供 Web 表单；
- 子代理只读，不能新建/编辑；
- 插件市场、hooks、output style、statusline、终端/IDE 命令不做 Web 管理；
- `/doctor` 等诊断命令仍走 CLI，输出会作为系统消息显示；
- 扩展面板依赖运行时已启动；会话未运行时会提示先发送消息/重新打开。
- 服务端进程若仍是旧构建（前端已更新但 `/api/sessions/:id/extensions` 路由未注册），
  接口会返回 404；Web 会明确提示「扩展接口不可用：服务端版本过旧或尚未重启，请重启
  claude-web 服务后再试」，不会再误报成「会话尚未运行」。构建后需重启服务，旧进程不会
  自动加载新路由。
