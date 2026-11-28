# 贡献指南

[English](CONTRIBUTING.md) | 简体中文

感谢你愿意花时间改进 Claude Code Web。bug 报告、文档修正和代码提交都有帮助。

## 可以怎么帮忙

- 报告 bug，附上版本、复现步骤和运行环境。
- 提出功能建议，说明使用场景和当前遇到的阻碍。
- 改进文档、翻译或截图。
- 提交代码，尤其是经过真实验证的修复和小而清晰的功能。

## 开始之前

- 小的文档修正和明确的 bug 可以直接开 PR。
- 涉及数据格式、权限语义、对外接口或新依赖的改动，请先开 issue 讨论，避免方向不一致。
- 这个项目的核心是**结构化的 Claude Code 控制台**，不是网页终端或完整 IDE。把项目变成无结构终端、文件编辑器或多 Agent 编排器的功能通常不在范围内，除非先讨论。

## 本地开发

需要 Node.js 20+ 和已登录的 `claude` CLI。

```bash
npm ci
npm run dev:server   # Fastify, :8010
npm run dev:web      # Vite, :5173，已代理 /api 与 /ws
```

生产构建与手动运行：

```bash
npm run build
DATA_DIR=./data PORT=8010 node dist/server/index.js
```

`npm run build` 必须通过。`build:server` 做严格的 TypeScript 检查；Vite 只负责打包，不检查 Vue 模板类型。

如果本地有开发树的 `.smoke/*.mjs`，先执行 `npm run build`，再直接运行单个脚本；本仓库不包含该目录。多数脚本会自己启动临时服务和数据目录；少数依赖外部服务或凭证，运行前请先读脚本头注释。浏览器脚本需要 Playwright Core 和系统 Chrome；真实 CLI 测试需要已登录的 `claude`，并可能消耗模型额度。

## 项目结构

```text
server/src    Fastify、Agent SDK 宿主、会话运行时、附件与语音
web/src       Vue 3 单页应用（登录、会话、聊天、设置）
scripts       密码重置、上游版本检查、发布打包、独立更新器
deploy        systemd / nginx 模板、更新签名公钥
docs          架构、实现、部署、语音、附件、扩展等设计文档
```

## 提交前检查

1. `npm run build` 通过。
2. 改动涉及 Claude Code 行为时，运行 `node scripts/check-upstream.mjs`，并更新 `docs/FEATURE-PARITY.md` 或 `docs/IMPLEMENTATION.md`。
3. UI 改动在亮色、暗色主题和 390px 宽度下检查过。
4. 没有把 `.env`、`data/`、transcript、附件或个人路径放进提交。
5. 文档和翻译已同步（见下一节）。

涉及运行时、审批、语音或附件的改动，建议再用一个真实会话做一次回归；只靠构建通过不足以覆盖这些链路。

## 代码与文案

- 保持 `build:server` 的严格 TypeScript 检查通过。
- 前端使用 Vue 3 单文件组件；新增依赖前请先说明理由，尤其是会进入生产依赖的包。
- 注释优先解释“为什么”，而不是重复代码在做什么。
- 中文文案直接写在组件里，通过 `t('中文')` 显示；新增或修改文案时，同步更新 `web/src/i18n.ts` 的 `EN` 字典。不要翻译 Claude 正文、工具原始输出、路径、模型名和用户数据。

## 文档与翻译

- 入口文档成对维护：`README.md` ↔ `README.en.md`、`SECURITY.md` ↔ `SECURITY.zh-CN.md`、`CONTRIBUTING.md` ↔ `CONTRIBUTING.zh-CN.md`。改一份时同步另一份，并保留顶部的语言切换。
- 设计文档以中文为事实源；修改 `docs/*.md` 时，同步更新 `docs/README.md` 和 `docs/README.en.md` 中对应的条目或摘要。新增设计文档必须同时加入两个索引。
- 完整策略见 [docs/I18N.md](docs/I18N.md)。

## 提交信息

使用 `feat:`、`fix:`、`docs:`、`refactor:`、`perf:`、`test:` 或 `chore:` 前缀。一个提交尽量只做一件事；行为变化请在正文里说明原因和验证方式。

## 安全

不要为命令执行、认证绕过或密钥泄露这类漏洞开公开 issue。报告渠道见 [SECURITY.zh-CN.md](SECURITY.zh-CN.md)。
