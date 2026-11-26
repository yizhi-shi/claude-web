# 系统更新与发布

> 状态: current
> 最后核对: 2026-11-26
> 关联: [部署](DEPLOYMENT.md) · [架构](ARCHITECTURE.md) · [安全](../SECURITY.zh-CN.md)

这里记录 Claude Code Web 的发布包、自动更新、回滚和签名机制。核心原则：

> **生产更新是“发布不可变版本 + 独立更新器 + 原子切换”，不是让 Web 进程覆盖自己的文件。**

## 1. 安装布局

发布安装使用版本目录：

```text
~/.local/share/claude-web/
  releases/
    0.13.0/
    0.14.0/
  current -> releases/0.14.0
  data/                    # 账号、transcript、附件、语音配置；更新不动
  bin/
    claude-web-update.mjs  # 独立更新器，位于 current 之外
    update-public-key.pem
  installed.json
```

- `current` 是相对软链，切换时使用临时软链 + `rename` 原子替换。
- `systemd` 的主服务以 `WorkingDirectory=<root>/current` 启动；`current` 改变后下次启动即新版本。
- 更新器独立于 `current`，应用坏了也能运行。
- `data/` 不参与版本切换；回滚时账号和会话仍然存在。

## 2. 发布包

`scripts/package-release.mjs` 从**脱敏后的公开导出树**构建：

```bash
npm run build
node scripts/package-release.mjs \
  --out dist-release \
  --base-url https://github.com/yizhi-shi/claude-web/releases/download/v0.14.0 \
  --sign-key .local-secrets/update-signing-key.pem
```

默认生成自带生产依赖的包（约 180 MB，`linux-x64-gnu`）；`--no-deps` 生成约 2 MB 的应用包，安装/更新时在目标端执行 `npm ci --omit=dev`。稳定部署推荐默认的自带依赖包。

产物：

```text
claude-web-0.14.0-linux-x64-gnu.tar.gz
claude-web-0.14.0-linux-x64-gnu.tar.gz.sha256
latest.json
latest.json.sig
SHA256SUMS
update-public-key.pem
```

`latest.json` 是更新协议的唯一入口：

```json
{
  "schema": 1,
  "name": "claude-web",
  "version": "0.14.0",
  "channel": "stable",
  "node": ">=20",
  "artifacts": [
    {
      "platform": "linux-x64-gnu",
      "url": "https://.../claude-web-0.14.0-linux-x64-gnu.tar.gz",
      "size": 187889752,
      "sha256": "...",
      "includesNodeModules": true
    }
  ]
}
```

`latest.json.sig` 是对 `latest.json` 原始字节的 Ed25519 签名。公钥在 `deploy/update-public-key.pem`，私钥只保存在开发机的 `.local-secrets/update-signing-key.pem`（0600，永不入库、不进入发布包）。

## 3. 发布流水线

私有树的 `scripts/publish.sh public` 在脱敏导出、提交、打 tag、推送之后：

1. 在临时公开 clone 中执行 `npm ci`、`npm run build`；
2. 执行 `scripts/package-release.mjs`，默认自带依赖；
3. 用 `.local-secrets/update-signing-key.pem` 签名；
4. `gh release create` / `gh release upload` 上传 tarball、`latest.json`、签名和公钥。

需要跳过自动发布会话时设置 `PUBLIC_SKIP_RELEASE=1`；只检查导出可设置 `PUBLIC_DRY_RUN=1`。

## 4. 安装与升级

新机器推荐预构建安装（不要求目标机有 npm/构建工具）：

```bash
git clone https://github.com/yizhi-shi/claude-web.git ~/claude-web-src
cd ~/claude-web-src
./install.sh --release
```

指定版本或镜像源：

```bash
./install.sh --release --version 0.14.0
./install.sh --release --feed https://mirror.example.com/claude-web
```

`install.sh --release` 转发到 `scripts/install-release.sh`。它会：

1. 下载并校验 `latest.json`、签名和对应平台 tarball；
2. 解压到 `releases/<version>`，原子切换 `current`；
3. 把独立更新器安装到 `bin/`；
4. 创建/保留 `data/` 和 `data/claude-web.env`；
5. 写入 `claude-web.service` 和 `claude-web-update.service`，启动主服务。

已有平铺安装（非 git）可以执行：

```bash
./install.sh --release --migrate
```

git 开发 checkout 不允许自动更新；请单独部署一个 release 实例。

## 5. 页面更新按钮

设置 → 系统更新：

- 展示当前版本、最新版本、安装形态、渠道、发布时间和大小；
- “检查更新”拉取并验证 feed；
- “立即更新”先写请求文件，再启动独立的 `claude-web-update.service`；
- 有运行中会话时先要求二次确认，确认后带 `force` 提交；
- 下载、校验、解压、预启动检查和切换阶段显示进度；
- 服务重启期间页面轮询 `/api/health`，恢复后自动刷新；
- 失败时显示原因；更新成功后保留“回滚上一版本”入口。

API：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/update/status` | 当前状态、缓存的最新版本、活动会话数、最近任务 |
| POST | `/api/update/check` | 强制检查 feed |
| POST | `/api/update/apply` | `{ version?, force? }`，写请求并启动更新器 |
| GET | `/api/update/job` | 与 status 相同的任务视图 |
| POST | `/api/update/rollback` | 回滚到 `installed.json` 记录的上一版本 |

所有接口都要求登录；前端不能传下载 URL。

## 6. 更新器流程

`bin/claude-web-update.mjs`（源码 `scripts/update/claude-web-update.mjs`）在独立 oneshot unit 中运行：

```text
读取 data/updates/request.json
  → 获取并验签 latest.json
  → 下载 tarball（按 sha256 缓存）
  → 校验大小 / sha256 / 签名
  → 检查 tar 路径、链接和类型
  → 解压到 data/updates/staging/
  → 校验 package.json 版本和必需文件
  → 可选：npm ci --omit=dev（应用包模式）
  → 用临时 DATA_DIR + 随机回环端口启动 staging，检查 /api/health
  → 停止 claude-web.service
  → 原子切换 current 软链
  → 启动 claude-web.service
  → 检查真实 /api/health 版本
  → 成功：写 installed.json、保留上一版本、清理旧版本
  → 失败：切回上一版本并重启
```

更新器状态写入 `data/updates/state.json`，日志追加到 `data/updates/update.log`。同一时间只允许一个更新任务（文件锁）。

## 7. 回滚

页面：

- 更新成功后，设置 → 系统更新 → “回滚上一版本”；
- 失败时显示错误；服务仍在线时可以直接回滚。

命令行：

```bash
node ~/.local/share/claude-web/bin/claude-web-update.mjs status
node ~/.local/share/claude-web/bin/claude-web-update.mjs rollback
```

回滚前提：

- 旧版本目录仍在 `releases/`；
- 数据迁移必须向后兼容。禁止在单个版本做不可逆迁移；需要破坏性变更时使用 expand/contract（先写双格式，跨版本删旧字段）。

## 8. 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPDATE_MODE` | `auto` | `auto` / `release` / `git` / `off` |
| `UPDATE_ROOT` | 进程 cwd | 安装根；release 安装由安装脚本写入 |
| `UPDATE_FEED_URLS` | 公开 GitHub latest | 逗号分隔的 feed 镜像，按顺序尝试 |
| `UPDATE_CHANNEL` | `stable` | 与 manifest 的 channel 必须一致 |
| `UPDATE_REQUIRE_SIGNATURE` | `1` | 默认强制 Ed25519 验签 |
| `UPDATE_PUBLIC_KEY_FILE` | `<root>/bin/update-public-key.pem` | 公钥路径 |
| `UPDATE_PUBLIC_KEY` | 空 | 内联公钥，优先级高于文件 |
| `UPDATE_PROXY_URL` | `HTTPS_PROXY` | 下载/检查代理 |
| `UPDATE_SERVICE_NAME` | `claude-web-update.service` | 独立更新器 unit |
| `UPDATE_WEB_SERVICE` | `claude-web.service` | 被更新/重启的主服务 |
| `UPDATE_SYSTEMD_SCOPE` | 有 `XDG_RUNTIME_DIR` 时 `user` | `user` / `system` |
| `UPDATE_HEALTH_URL` | `http://127.0.0.1:<PORT>/api/health` | 健康检查地址 |
| `UPDATE_KEEP_RELEASES` | `3` | 保留的版本目录数量 |

更新器额外支持 `UPDATE_STOP_COMMAND` / `UPDATE_START_COMMAND` 供测试或非 systemd 编排使用；生产默认由 systemd 管理。

## 9. 安全边界

- 更新等价于在服务器执行远端代码；默认必须 HTTPS + sha256 + Ed25519 验签。
- 前端不能提供 feed URL、命令或安装脚本。
- tar 解压拒绝绝对路径、`..`、越界软链和设备文件。
- 发布包只包含静态运行文件，不执行包内脚本。
- 更新接口要求登录，并记录 `update.check` / `update.apply` / `update.rollback` 审计。
- 私有部署建议把 release 资产镜像到自己的 HTTPS 域名；不要在服务端长期保存 GitHub token。

## 10. 冒烟测试

先构建：

```bash
npm run build
```

然后：

```bash
node .smoke/update-smoke.mjs
node .smoke/side-question-test.mjs
node .smoke/new-session-path-test.mjs
```

- `update-smoke.mjs`：假 feed + 最小发布包，验证下载、验签、staging 健康检查、软链切换、回滚、篡改拒绝和 `/api/update/*`。
- `side-question-test.mjs`：主回合运行中旁问不阻塞、不写入主会话。
- `new-session-path-test.mjs`：工作目录输入实时联动、竞态、错误提示和 Escape 恢复。

真实发布安装可在一台临时机器上执行：

```bash
./install.sh --release --dir /tmp/claude-web-release --no-service
```

## 11. 已知限制

- release 包按平台构建；`linux-x64-gnu` 之外需要各自构建，未匹配平台时更新器会明确拒绝。
- 更新会停止主服务几秒，正在执行的会话会被中断；前端会先要求确认。
- 更新器会在启动后做健康检查并在失败时切回上一版本；如果新版本启动成功后运行一段时间才崩溃，需要人工回滚。
- git 开发工作区和平铺安装不会直接自动更新；平铺安装可执行 `install.sh --release --migrate`。
- 暂无灰度/分批发布；`stable` / `beta` 通过 `UPDATE_CHANNEL` 区分，beta 不进入 stable 的 feed。
