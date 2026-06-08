# RoamCli

RoamCli 是一个开源的远程 AI 编码 Agent 控制平台。它通过反向 WebSocket 连接，把响应式 Web 客户端、TypeScript 中心服务端和一个或多个开发机 Runner 连接起来。

英文文档见 [README.md](README.md)。

## 当前包含内容

本仓库实现了一个可用的远程 Agent 控制 MVP：

- Fastify 服务端：支持 Bearer Token 认证、SQLite 持久化、本地 artifact 存储、静态 Web 托管、客户端流式 WebSocket、Runner 反向 WebSocket。
- Runner CLI：支持进程管理、PTY 降级、重连缓存、解析器回放、审批转发、审计哈希链、文件树/文件内容 RPC、安全 UTF-8 文件写入、签名 patch apply，以及 strict/standard/trusted 三种权限 profile。
- React Web 客户端：支持桌面/平板/移动端响应式布局、Runner/Session 控制、聊天流、文件浏览、文本文件编辑、终端输入/输出、审批中心、patch review、PWA manifest 和 service worker。
- 共享的 protocol、security、parser SDK 包，并配套测试。
- Smoke/E2E 验证：启动真实 Server + Runner，验证 session 创建、持久化、文件读写、终端输入、错误 patch 签名拒绝、签名 patch apply。
- Browser blackbox 验证：用 Chromium 驱动真实 Web UI，覆盖桌面、平板和移动端视口。

## 前置条件

- Node.js 24 或更新版本。smoke 脚本需要运行时提供全局 `WebSocket`。
- pnpm 10 或更新版本。本仓库声明 `packageManager: pnpm@10.33.0`。
- Git。
- 可选：如需浏览器验证，安装带 Chromium 的 Playwright。

如果本机没有 pnpm：

```bash
corepack enable
corepack prepare pnpm@10.33.0 --activate
```

## 安装

```bash
pnpm install
```

## 构建与测试

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:e2e
pnpm blackbox:browser
```

`pnpm smoke:e2e` 默认会启动自己的本地 Server 和 Runner，使用 `mock` agent 创建真实 session，并验证 MVP 主路径，不依赖 mock HTTP 响应。

`pnpm blackbox:browser` 会构建应用、启动本地 Server 和 Runner、在 Chromium 中打开真实 Web UI，并验证空 Runner 状态以及桌面/平板/移动端用户路径：聊天、文件浏览/编辑/保存、终端输入、exec 审批通过/拒绝、artifact 展示、patch review/apply。默认使用隔离的临时 Runner 工作区；可以设置 `ROAMCLI_BLACKBOX_WORKSPACE` 指向指定工作区。

## 本地运行

启动 Server。若 `apps/web/dist` 存在，Server 会托管构建后的 Web UI。

```bash
HOST=127.0.0.1 \
PORT=8787 \
ROAMCLI_AUTH_TOKEN=dev-token \
ROAMCLI_DATA_DIR=.roamcli-server \
ROAMCLI_RUNNER_RPC_TIMEOUT_MS=10000 \
pnpm --filter @roamcli/server dev
```

另开一个 shell，启动 Runner，并把当前仓库暴露为工作区：

```bash
pnpm --filter @roamcli/runner dev \
  --server ws://127.0.0.1:8787/v1/runner \
  --token dev-token \
  --runner-id local-real \
  --workspace "$PWD" \
  --profile trusted
```

打开：

```text
http://127.0.0.1:8787
```

如果 Web UI 的 token 输入框没有自动填充，请输入 `dev-token`。

## 创建 Session

1. 确认左侧边栏中能看到 Runner。
2. 本地验证可选择 `mock` agent；如果 Runner 机器上安装了对应 CLI，也可以选择 `claude`、`codex`、`gemini`、`aider` 或 `shell`。
3. 将工作目录设置为 Runner workspace 内部的路径。
4. 使用 Files 面板浏览和编辑 UTF-8 文本文件。
5. 使用 Terminal 面板向当前 session 发送输入。
6. 使用 Approvals 面板通过/拒绝 exec 请求，并应用已签名 patch。

## Runner CLI 参数

```text
--server      Server websocket URL。http/https 会转换为 ws/wss。
--token       WebSocket 注册和 patch 签名校验使用的 Bearer token。
--profile     权限 profile：strict、standard、trusted。默认：standard。
--runner-id   稳定 Runner id。默认：hostname 加 UUID。
--workspace   暴露给 session 的工作区根目录。默认：cwd。
```

等价环境变量：

```text
ROAM_RUNNER_SERVER
ROAM_RUNNER_TOKEN
ROAM_RUNNER_PROFILE
ROAM_RUNNER_ID
ROAM_RUNNER_WORKSPACE
```

每类 agent 的命令和参数可通过环境变量覆盖：

```text
ROAMCLI_AGENT_CLAUDE_COMMAND
ROAMCLI_AGENT_CLAUDE_ARGS
ROAMCLI_AGENT_CODEX_COMMAND
ROAMCLI_AGENT_CODEX_ARGS
ROAMCLI_AGENT_GEMINI_COMMAND
ROAMCLI_AGENT_GEMINI_ARGS
ROAMCLI_AGENT_AIDER_COMMAND
ROAMCLI_AGENT_AIDER_ARGS
ROAMCLI_AGENT_MOCK_COMMAND
ROAMCLI_AGENT_MOCK_ARGS
ROAMCLI_AGENT_SHELL_COMMAND
ROAMCLI_AGENT_SHELL_ARGS
```

`*_ARGS` 支持类 shell 字符串，也支持 JSON 字符串数组。

## Server 环境变量

```text
HOST                         绑定 host。默认：127.0.0.1。
PORT                         绑定端口。默认：3000。
ROAMCLI_AUTH_TOKEN           HTTP 和 WebSocket 认证使用的 Bearer token。
ROAMCLI_APPROVAL_SECRET      审批和 patch apply 的 HMAC secret。默认使用 auth token。
ROAMCLI_DATA_DIR             SQLite/artifact 数据目录。默认：.roamcli-server。
ROAMCLI_WEB_DIST             构建后 Web 资源路径。存在时默认 apps/web/dist 或 ../web/dist。
ROAMCLI_RUNNER_RPC_TIMEOUT_MS Runner RPC 超时时间。默认：5000。
```

## Smoke/E2E 选项

```text
ROAMCLI_SMOKE_BASE_URL            连接已有 server，而不是启动新 server。
ROAMCLI_SMOKE_TOKEN               Bearer token。默认：dev-token。
ROAMCLI_SMOKE_RUNNER_ID           要使用或启动的 Runner id。默认：smoke-<pid>。
ROAMCLI_SMOKE_WORKSPACE           暴露给 Runner 的工作区。默认：仓库根目录。
ROAMCLI_SMOKE_SKIP_BUILD=1        跳过 protocol/security 预构建。
ROAMCLI_SMOKE_TIMEOUT_MS          单步超时时间。默认：30000。
ROAMCLI_SMOKE_EXPECT_PATCH_APPLY=0 跳过 patch apply 断言。
```

## 浏览器验证

如果 Chromium 尚未安装，先安装 Playwright 浏览器：

```bash
pnpm exec playwright install chromium
```

先运行常规验证：

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:e2e
pnpm blackbox:browser
```

如果需要手动检查应用，再按上文启动 Server + Runner。

`pnpm blackbox:browser` 支持：

```text
ROAMCLI_BLACKBOX_BASE_URL       连接已有 server，而不是启动新 server。
ROAMCLI_BLACKBOX_TOKEN          Bearer token。默认：dev-token。
ROAMCLI_BLACKBOX_RUNNER_ID      要使用或启动的 Runner id。默认：blackbox-<pid>。
ROAMCLI_BLACKBOX_WORKSPACE      暴露给 Runner 的工作区。默认：临时隔离工作区。
ROAMCLI_BLACKBOX_TIMEOUT_MS     单步超时时间。默认：45000。
ROAMCLI_BLACKBOX_HEADFUL=1      测试时显示 Chromium。
```

## Docker Compose

启动 compose 前先构建 Web UI：

```bash
pnpm install
pnpm build
docker compose up --build
```

compose 配置面向本地部署基线。公开暴露前应补充 HTTPS、反向代理、持久化 volume、备份和认证加固。

## 仓库结构

```text
apps/server       Fastify API、WebSocket hub、持久化、artifacts、静态 Web 托管。
apps/runner       Runner CLI、进程适配器、文件 RPC、patch apply、审计/缓存。
apps/web          React 客户端。
packages/protocol 共享 Zod schema 和 TypeScript 类型。
packages/security 加密、签名、哈希和审计工具。
packages/parser-sdk Agent parser SDK 和 fixture replay 测试。
scripts           Smoke/E2E 和 browser blackbox runner。
docs              PRD 状态和任务跟踪。
```

## 说明

- 运行时状态位于 `.roamcli-server/` 和 `.roam-runner/`，它们已被 Git 忽略。
- 构建产物、Playwright 截图、测试报告、数据库和日志已被 Git 忽略。
- 当前 MVP 使用 Bearer token/HMAC 签名。Runner 侧 patch apply 会重新校验签名；生产部署仍应补充 secret 隔离、重放窗口、HTTPS、OIDC 或更强认证，以及审计导出。
- 本项目使用 EESPL 2.0 许可证。见 [LICENSE](LICENSE)。
