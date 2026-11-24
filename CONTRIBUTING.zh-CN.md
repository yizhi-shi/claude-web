# 贡献指南

[English](CONTRIBUTING.md) | 简体中文

感谢你帮助改进 Claude Code Web。

## 开发

```bash
npm install
npm run build
DATA_DIR=./data PORT=8010 node dist/server/index.js
```

开发 UI：

```bash
npm run dev:server   # Fastify :8010
npm run dev:web      # Vite :5173，已代理 /api 与 /ws
```

## 提交 PR 前

1. `npm run build` 通过。
2. `node scripts/check-upstream.mjs` 仍与本机 Claude Code CLI/SDK 版本族匹配。
3. 不包含任何密钥、`data/`、`.env`、transcript 或个人路径。
4. UI 改动在亮色/暗色主题和 390px 宽度下都正常。
5. **中英文同步**：
   - 新增或修改用户可见文案时，同时更新 `web/src/i18n.ts` 的中文源串和 `EN` 字典；
   - 修改 `README.md` / `README.en.md`、`SECURITY.md` / `SECURITY.zh-CN.md`、`CONTRIBUTING.md` / `CONTRIBUTING.zh-CN.md` 中的任意一份时，同步更新另一份；
   - 修改设计类 `docs/*.md` 时，同步更新 `docs/README.en.md` 中对应的英文摘要；
   - 细节见 [docs/I18N.md](docs/I18N.md)。
6. 如果改动涉及 Claude Code 行为，更新 `docs/FEATURE-PARITY.md` 或 `docs/IMPLEMENTATION.md`。

## 范围

核心是一个面向 Claude Code 的**结构化 Web 控制台**，不是终端替代品或完整 IDE。把项目变成无结构终端、文件编辑器或多 Agent 编排器的功能通常不在范围内，除非先讨论。

## 提交信息风格

使用 `feat:`、`fix:`、`docs:`、`refactor:`、`perf:`、`test:` 或 `chore:`。

## 安全

不要为暴露命令执行、认证绕过或密钥泄露的漏洞开公开 issue。见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。
