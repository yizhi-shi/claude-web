# 部署教程（人工 / Agent）

> 状态: current
> 最后核对: 2026-11-26
> 关联: [README](../README.md) · [架构](ARCHITECTURE.md)

## 人工部署

### 前置条件

- Linux（systemd 推荐）
- Node.js 20+
- npm、git、curl
- 已安装并登录的 `claude` CLI（`claude --version` 可用）
- 可选：`ffmpeg`（火山引擎语音渠道）

### 用户级安装：发布包（推荐）

安装预构建、带签名的 release，不在目标机执行 npm 或构建：

```bash
git clone https://github.com/yizhi-shi/claude-web.git ~/claude-web-src
cd ~/claude-web-src
./install.sh --release
```

- 安装目录：`~/.local/share/claude-web`
- 版本目录：`~/.local/share/claude-web/releases/<version>`
- 当前版本：`current -> releases/<version>`
- 数据目录：`~/.local/share/claude-web/data`
- 独立更新器：`~/.local/share/claude-web/bin/claude-web-update.mjs`
- 服务：`systemctl --user` + `loginctl enable-linger`
- 新会话权限：`default`（每次敏感操作询问）

指定版本或镜像源：

```bash
./install.sh --release --version 0.14.0
./install.sh --release --feed https://mirror.example.com/claude-web
```

已存在的平铺安装（非 git）可以迁移：

```bash
./install.sh --release --migrate
```

发布包安装默认启用设置页的“检查更新 / 立即更新 / 回滚”，详见 [系统更新](UPDATER.md)。

### 用户级安装：源码（开发）

```bash
git clone https://github.com/yizhi-shi/claude-web.git ~/claude-web-src
cd ~/claude-web-src
./install.sh --from-dir .
```

源码安装会在目标机执行 `npm ci` 和 `npm run build`，不启用自动更新；适合开发和调试。

常用参数：

```bash
./install.sh --from-dir . --port 8010 --host 0.0.0.0
./install.sh --from-dir . --permission-mode bypassPermissions   # 个人可信设备
sudo ./install.sh --system --dir /opt/claude-web --user "$SUDO_USER"
```

### 首次登录

1. 打开 `http://<设备IP>:8010`。
2. 首次显示「初始化管理员」；设置用户名与至少 8 位密码。
3. 创建后自动登录；密码以 bcrypt 哈希存 `data/auth.json`（0600）。
4. 连续 5 次密码错误锁定该账号 1 小时。
5. 邮箱验证码（可选）：
   - 推荐直接在「设置 → 管理员账号 → 邮箱登录验证」填写 SMTP 服务器、端口、SSL/STARTTLS、用户名、密码和发件地址；保存时会先发一封测试邮件，成功后才写入 `data/mail.json`（0600）。
   - 也可以准备一个 0600 的 SMTP 凭据文件（`SMTP_HOST/PORT/SECURITY/USER/PASS`、`MAIL_FROM/MAIL_TO`），在 `data/claude-web.env` 设置 `MAIL_ENV_FILE=/path/to/mail.env` 作为回退；设置页保存的 `data/mail.json` 优先。
   - 保存收件邮箱并开启邮箱验证后，登录将变成“密码 + 邮箱 6 位验证码”；验证码 10 分钟过期，最多尝试 5 次。
   - SMTP 故障或邮箱不可用时，在服务器执行 `npm run disable-2fa`，再重启服务；这是本地 break-glass，不通过 Web 暴露。
6. 忘记密码：
   ```bash
   cd ~/.local/share/claude-web
   npm run set-password -- <用户名> <新密码>
   systemctl --user restart claude-web
   ```

### 服务管理

```bash
systemctl --user status claude-web
systemctl --user restart claude-web
journalctl --user -u claude-web -f
```

系统级安装把 `--user` 去掉。

### 升级

发布包安装（推荐）：

- 打开「设置 → 系统更新」，点“检查更新”，再点“立即更新”；
- 更新器会下载、验签、预启动检查、切换版本并重启服务；
- 有运行中会话时会要求二次确认；更新会中断这些会话。

命令行等价操作：

```bash
node ~/.local/share/claude-web/bin/claude-web-update.mjs check
node ~/.local/share/claude-web/bin/claude-web-update.mjs apply
node ~/.local/share/claude-web/bin/claude-web-update.mjs status
```

回滚：

```bash
node ~/.local/share/claude-web/bin/claude-web-update.mjs rollback
# 或页面：设置 → 系统更新 → 回滚上一版本
```

源码安装仍可手工升级：

```bash
cd ~/.local/share/claude-web
git pull --ff-only
npm ci
npm run build
systemctl --user restart claude-web
```

`data/` 不会被覆盖；升级前可备份该目录。发布包的详细机制、签名、feed 和故障处理见 [系统更新](UPDATER.md)。

### 反向代理与 HTTPS

应用登录之外，公网部署建议：

- 反向代理到 `127.0.0.1:8010`（同机）或内网主机；
- 开启 WebSocket upgrade；
- 关闭代理缓冲并放长读超时；
- 叠加统一身份网关、Authelia 或基本认证；
- 只开放 443，后端端口不直接暴露。

示例见 [deploy/nginx-claude.conf.example](../deploy/nginx-claude.conf.example)。

### 语音识别与实时流式

语音渠道在「设置 → 语音识别」配置，桌面和手机共用；聊天框麦克风直接开始/结束听写。

- 整段转写需要对应的 API Key 或浏览器 `SpeechRecognition`；火山引擎整段转写还需要 `ffmpeg`。
- 实时流式三个服务端渠道都支持：
  - Gemini Live 需要服务端能访问一个**支持 Google 地区的 WebSocket 中转**（本项目不内置中转服务）。在设置页填写 Live 模型、中转地址和内部 Token，或用环境变量：
    ```bash
    GEMINI_LIVE_URL=wss://relay.example.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent
    GEMINI_LIVE_PROXY_TOKEN=...
    GEMINI_LIVE_MODEL=gemini-3.5-transcribe-live
    # 可选：语音请求经本地出口代理
    VOICE_PROXY_URL=http://127.0.0.1:7890
    ```
  - OpenAI 官方 Realtime 需要账号支持 `?intent=transcription`；其它 OpenAI 兼容服务默认用分段实时（静音断句 + HTTP 转写），也可填自定义 Realtime 网关地址。
  - 火山引擎实时复用 App ID / Access Key / Resource ID，直接连 `wss://openspeech.bytedance.com/api/v3/sauc/bigmodel`，不需要 `ffmpeg`。
- Key/Token 只保存在服务端 `data/voice.json`（0600）或服务环境变量中，不会下发给浏览器。截图和示例文档里请只使用占位符。实时不可用时会自动回退到整段转写。
- 浏览器麦克风只在 HTTPS 或 localhost 下可用；公网部署请使用 HTTPS；反向代理需要允许 `/ws/voice` 的 WebSocket upgrade。

### 附件存储

- 附件保存在 `DATA_DIR/attachments/<sessionId>/`，文件名由服务端随机生成，文件与侧车元数据均为 `0600`；`data/` 备份应包含该目录。
- 限制：`MAX_ATTACHMENTS`（默认 5）、`MAX_ATTACHMENT_MB`（默认 10）、`MAX_TOTAL_ATTACHMENT_MB`（默认 20）。Fastify 请求体上限是 18 MB，base64 会膨胀约 1/3；调大单文件上限时要同步确认仍低于请求体上限。
- 反向代理要允许附件 JSON 上传；nginx 示例里的 `client_max_body_size` 不能小于应用上限。
- 目前没有自动清理/配额：上传后未发送、移除 chip 或发送失败都会留下文件，长期运行需要定期清理 `data/attachments`（Roadmap 已列）。删除目录只影响历史附件显示，不影响 transcript 中的文字记录。
- 工具结果图片保存在 `DATA_DIR/tool-images/<sessionId>/`（文件与 sidecar 均 `0600`），读取需要登录，不是公开静态目录；备份 `data/` 时应包含它。它同样没有配额/自动清理。
- 非图片附件以 `application/octet-stream` 强制下载；不要把 `data/attachments` 直接暴露为静态目录。

### 卸载

```bash
cd ~/.local/share/claude-web
./uninstall.sh              # 保留数据
./uninstall.sh --purge --yes # 删除安装目录和数据
```

### 排障

| 现象 | 检查 |
|---|---|
| 首页打不开 | `systemctl --user status`、端口 `ss -ltn`、反向代理 |
| 登录一直失败 | 是否连续锁定；浏览器 Cookie；`data/auth.json` 权限 |
| 发送无回复 | `claude --version`、`CLAUDE_BIN`、`HOME`、模型通道环境 |
| 刷新后状态丢失 | WebSocket 是否被代理缓冲/超时；看服务日志 |
| 语音无权限 | 是否 HTTPS/localhost；浏览器站点麦克风权限 |
| 火山引擎语音失败 | `ffmpeg`、App ID/Access Key/Resource ID |

## Agent 部署教程

把以下提示词复制给 Claude Code 或其他终端 Agent：

```text
你是一名 Linux 运维助手。请在这台机器上安装并验证 Claude Code Web：

1. 检查 node -v 是否 >= 20，npm、git、claude --version 是否可用；claude 必须已登录。
2. 执行：
   git clone https://github.com/yizhi-shi/claude-web.git ~/claude-web-src
   cd ~/claude-web-src
   ./install.sh --from-dir . --port 8010 --host 0.0.0.0
3. 等待服务启动，验证：
   curl -fsS http://127.0.0.1:8010/api/health
   systemctl --user is-active claude-web
4. 输出访问地址（http://<局域网IP>:8010）和“首次打开设置管理员账号”的说明。
5. 不要输出任何密钥、token 或 data/ 下的文件内容。

验收标准：health 返回 ok、服务 active、端口 8010 在监听、首页可访问。
```

如果 Agent 有 shell 权限，也可以直接让它执行 `./install.sh --from-dir .` 并读取输出。管理员密码应由人在浏览器里首次设置，不要交给 Agent 生成或记录。

## 安全建议

- 默认 `default` 权限最安全；`bypassPermissions` 只用于个人可信设备。
- 公网务必 HTTPS；控制台等价于服务运行用户的远程终端。
- `data/` 包含账号、语音 Key 和对话记录，请按敏感数据保护，并定期备份。
- 定期备份 `data/`；升级前先备份。
- 生产建议使用独立用户并限制 `ALLOWED_ROOTS`。
