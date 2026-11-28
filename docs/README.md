# 文档索引

[English](README.en.md) | 简体中文

这里汇总项目的公开文档。入口文档提供完整中英双语；设计文档以中文为事实源，英文索引提供对应摘要。

## 入口文档

| 文档 | 内容 |
|---|---|
| [README](../README.md) | 项目介绍、功能、安装、配置、常见问题 |
| [SECURITY](../SECURITY.zh-CN.md) | 威胁模型、漏洞报告、部署要求与内置防护 |
| [CONTRIBUTING](../CONTRIBUTING.zh-CN.md) | 开发环境、提交前检查、代码与文档规范 |

## 设计与实现

| 文档 | 内容 |
|---|---|
| [架构与不变量](ARCHITECTURE.md) | 浏览器、Fastify、`ClaudeRuntime` 和 CLI 的分工；事件模型、会话生命周期与必须保持的不变量 |
| [核心实现说明](IMPLEMENTATION.md) | 为什么选择 Agent SDK、命令与 Skill 的来源、事件归一化、历史恢复、旁问和常见陷阱 |
| [附件链路](ATTACHMENTS.md) | 从浏览器上传到 Claude Code 接收的完整路径、存储格式、限制与安全边界 |
| [工具结果图片与文本预览](TOOL-IMAGES.md) | 工具返回图片的落盘与鉴权、页内 lightbox、新标签文本预览、运行中追加消息的确认与恢复 |
| [扩展管理范围](EXTENSIONS.md) | 为什么 Web 只做 MCP 状态/重连/启停和子代理只读列表，而不做插件市场、Hooks 与 MCP 编辑 |
| [部署教程](DEPLOYMENT.md) | 人工与 Agent 部署、首次登录、服务管理、反向代理、语音与附件存储、排障 |
| [系统更新与发布](UPDATER.md) | 发布包、Ed25519 签名、版本目录与 `current` 软链、独立更新器、回滚 |
| [语音渠道](VOICE-ASR.md) | Gemini、Gemini Live、OpenAI Realtime、OpenAI 分段实时、火山引擎和浏览器识别的实现与取舍 |
| [中英文界面](I18N.md) | `t()` 字典、语言选择与持久化、服务端错误翻译、双语文档策略 |
| [UI 布局与交互决策](UI-DESIGN.md) | 视觉方向、桌面/手机布局、组件职责、面板、输入区、设置页和可访问性 |
| [VSCode 插件能力对照](FEATURE-PARITY.md) | 与 VSCode Claude Code 插件的能力矩阵，以及升级 CLI/SDK 后的回归清单 |

## 项目与规划

| 文档 | 内容 |
|---|---|
| [Roadmap](ROADMAP.md) | 已具备的能力、已知限制、后续优先级和产品原则 |
| [同类项目调研](COMPETITIVE-RESEARCH.md) | 对 claudecodeui、opcode、Kanna、claude-run 等项目的观察，以及明确的取舍 |

## 按任务查找

| 我想…… | 先看 |
|---|---|
| 安装到一台 Linux 主机 | [README 快速开始](../README.md#快速开始) 或 [部署教程](DEPLOYMENT.md) |
| 理解“关掉浏览器任务还在跑”的原理 | [架构与不变量](ARCHITECTURE.md)、[核心实现说明](IMPLEMENTATION.md) |
| 配置语音输入 | [README 语音识别](../README.md#语音识别)、[语音渠道](VOICE-ASR.md) |
| 改附件或工具图片行为 | [附件链路](ATTACHMENTS.md)、[工具结果图片](TOOL-IMAGES.md) |
| 加一个 Web 原生命令 | [核心实现说明](IMPLEMENTATION.md)、[UI 布局与交互](UI-DESIGN.md) |
| 发布新版本或排查更新失败 | [系统更新与发布](UPDATER.md) |
| 对齐新版 Claude Code 能力 | [VSCode 插件能力对照](FEATURE-PARITY.md) |
| 改界面文案或加语言 | [中英文界面](I18N.md)、[贡献指南](../CONTRIBUTING.zh-CN.md) |

## 维护规则

- 一个事实只有一个家：架构、实现、部署、更新等细节写在对应的设计文档里，README 只做概述和索引。
- 修改设计文档时，同步更新本页和 [英文索引](README.en.md) 中的条目；新增文档必须同时加入两个索引。
- 入口文档成对维护，中文和英文改动同步进行。
- 文档中的命令、默认值和路径应与代码保持一致；改动行为时顺手修正对应文档，而不是留到以后。
