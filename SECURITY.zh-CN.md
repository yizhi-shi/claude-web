# 安全策略

[English](SECURITY.md) | 简体中文

## 威胁模型

Claude Code Web 以服务运行用户的身份运行本机 `claude` CLI。任何能使用控制台的人，都能以该用户的权限执行命令、修改文件。请把它当作**远程终端**，而不是只读看板。

## 部署要求

- 不要把 8010 端口直接暴露到公网。
- 使用 HTTPS 和反向代理；建议再叠加统一身份网关等额外认证层。
- 尽可能使用专用的低权限用户运行。
- 保持 `ALLOWED_ROOTS` 范围足够小。
- 默认权限模式是 `default`；`bypassPermissions` 很危险，必须显式选择。
- `data/` 包含凭据和对话记录；保持 `0600` 权限并排除在 Git 之外。

## 报告漏洞

请使用本仓库 GitHub 的**私密漏洞报告 / 安全公告**功能。不要在公开 issue 中包含真实 token、密码、私有 IP 或客户数据。

请提供：

- 受影响的版本/提交；
- 复现步骤；
- 影响；
- 建议修复方式（如果已知）。

## 内置缓解措施

- 首次运行初始化管理员；没有默认密码。
- bcrypt 密码哈希；HMAC 签名的 HttpOnly Cookie；SameSite=Strict。
- 同一账号连续 5 次失败锁定 1 小时；登录接口按 IP 限流。
- 对改变状态的请求和 WebSocket 握手做 Origin 校验。
- CSP、禁止 iframe 嵌入、nosniff 和 no-referrer 响应头。
- 工作区访问使用 realpath 校验的路径白名单。
- 权限审批超时和明确的停止语义。
- 语音 Key 在 API 响应中只返回掩码，且只存储在服务端。
- 附件保存在 `data/attachments/<sessionId>/`，使用服务端生成的随机文件名和 `0600` 权限；上传和下载都要求会话 Cookie，附件 id 绑定所属会话。绝不使用客户端提供的路径。
- 附件上传在服务端强制执行严格的 base64 解码、MIME 语法检查、显示名 basename/清洗、生成磁盘文件名，以及单文件/数量/总大小限制。附属元数据在每次读取时都会重新校验。
- 只有 PNG/JPEG/GIF/WebP 会被当作图片（刻意排除 SVG）。非图片文件强制使用 `application/octet-stream` + `Content-Disposition: attachment`；图片使用内联 disposition 和白名单 MIME。CSP + `nosniff` 进一步降低同源脚本执行风险。
- Fastify 请求体上限为 18 MB；base64 膨胀后附件限制应保持在其之下。反向代理必须配置兼容的 `client_max_body_size`。
- 上传文件不会做病毒扫描，其内容会进入模型上下文；请把附件视为不可信输入。
- 旁问作为 fork 的、不持久化的查询运行，移除全部工具并拒绝所有工具请求；不写入主 transcript，并在请求 WebSocket 或会话停止时取消。
- MCP 状态响应采用白名单：只包含服务器名称/状态/scope/source/服务器信息/错误/工具名和描述。MCP `config`、`env`、HTTP headers、命令路径和 token 永远不会发送到浏览器。启用/停用和重连只作用于当前 SDK 会话；Web UI 不修改 MCP 配置或 agent/插件文件。
