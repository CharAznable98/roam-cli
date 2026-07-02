# RoamCli

英文文档见 [README.md](README.md)。

RoamCli 是一个自托管的 Web 控制面，用来在开发机上运行 AI 编码 Agent。它通过反向 WebSocket 连接浏览器界面、中心 TypeScript Server 和一个或多个 Runner，让你可以在 Web 里创建 Agent Session、查看项目文件、接收终端输出、处理审批，并应用 patch。

## 工作方式

RoamCli 由三个彼此独立的部分组成：

- **Server**：中心控制面，提供 Web UI、HTTP API、WebSocket hub、SQLite 数据和本地 artifact 存储。
- **Runner**：运行在开发机或任何能访问代码的机器上。Runner 会主动连接 Server，负责启动 Agent、读写 workspace 文件、转发终端输出，并应用已批准的 patch。
- **Web UI**：由 Server 提供的浏览器界面。浏览器只需要访问 Server，不需要直接访问 Runner。

Runner 使用反向 WebSocket 连接，因此运行 Runner 的机器通常只需要能出站访问 Server，不需要暴露入站端口。

## 前置条件

- Node.js 24 或更新版本。
- pnpm 10 或更新版本。本仓库声明 `packageManager: pnpm@10.33.0`。
- Git。
- Server 安装脚本需要 Docker 和 Docker Compose。
- Runner 机器上已安装所选 Agent 插件需要的编码 Agent，例如 `@roamcli/agent-codex` 需要 Codex。

## 安装

### Server：Docker 安装脚本

推荐的 Server 安装方式是 Release 附带的安装脚本。脚本支持 macOS 和 Linux，会检测 Git、Docker、Docker Compose，拉取选定的 release tag，在本机构建 Server 镜像，并用 Docker Compose 启动。RoamCli 不依赖发布好的 Docker image。

```bash
curl -fsSL https://github.com/CharAznable98/roam-cli/releases/latest/download/install-server.sh -o install-server.sh
chmod +x install-server.sh
./install-server.sh
```

默认值：

- 安装目录：`~/.roamcli/server`
- Server 数据目录：`~/.roamcli/server/data`
- 监听地址：`0.0.0.0:8787`
- Release ref：最新 GitHub release tag

安装或升级到指定旧版本使用同一个脚本：

```bash
./install-server.sh --version v1.1.0
```

常用选项：

```bash
./install-server.sh --public-origin https://roam.example.com
./install-server.sh --dry-run
./install-server.sh --uninstall
```

`--uninstall` 会停止并删除脚本生成的 Server 部署文件。删除 Server 数据前会二次确认；默认保留数据。

Windows 用户建议在启用 Docker Desktop 集成的 WSL2 中运行安装脚本，或使用下面的源码安装方式。

### Server：源码安装

源码安装适合本地开发，或你希望自行管理进程的场景：

```bash
pnpm install
pnpm build
```

`pnpm build` 会构建 Server 相关包和 Server 可托管的 Web UI 静态资源。

## 运行 RoamCli

如果通过 `install-server.sh` 安装 Server，直接打开配置的地址即可。源码 checkout 则先启动 Server：

```bash
HOST=127.0.0.1 \
PORT=8787 \
ROAMCLI_DATA_DIR=.roamcli-server \
pnpm --filter @roamcli/server dev
```

首次启动时 Server 会在日志中打印 setup token，并写入 `.roamcli-server/setup-token.txt`。打开 Web UI，输入 setup token 并设置 owner 密码。完成后在 Web UI 的 **Account & Security** 中复制 Runner token 或完整 Runner 命令。

另开一个 shell，在你希望暴露为 Runner workspace 的目录下启动 Runner。Web UI 会在你选择至少一个 Agent 插件后生成这个 `npx` 命令：

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner \
  --server ws://127.0.0.1:8787/v1/runner \
  --token <runner-token-from-account-security> \
  --agent-plugin @roamcli/agent-codex
```

Runner 会把最终生效的启动配置写入 `<workspace>/<data-dir>/config.json`，默认是 workspace 下的 `.roam-runner/config.json`。之后在同一 workspace 启动时可以省略已持久化的参数，但所选插件包仍需要由 `npx` 提供：

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner
```

如果交互式终端里缺少必填参数，Runner 会进入 React Ink TUI 向导，并在收集完成后自动 re-exec 完整 `npx` 命令。非交互式环境必须显式传入 `--server`、`--token` 和至少一个 `--agent-plugin`。

打开 Web UI：

```text
http://127.0.0.1:8787
```

## 使用 RoamCli

1. 确认 Runner 已在线。
2. 创建 Project，选择 Runner；界面会把该 Runner 的 workspace 固定为目录前缀，你只需要填写其下的相对项目路径。
3. 在 Project 下创建 Session。
4. 在 Chat 面板向 Agent 发送提示。
5. 在 Files 面板浏览和编辑 Session 目录内的 UTF-8 文本文件。
6. 在 Terminal 面板向当前 Session 发送输入。
7. 在 Approvals 面板处理批准或拒绝请求，并应用已接受的 patch。

## Server 配置

| 变量                    | 说明                                                                                                               | 默认值                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| `HOST`                  | Server 绑定地址。                                                                                                  | `127.0.0.1`                               |
| `PORT`                  | Server 绑定端口。                                                                                                  | `3000`                                    |
| `ROAMCLI_DATA_DIR`      | SQLite 数据和本地 artifacts 目录。                                                                                 | `.roamcli-server`                         |
| `ROAMCLI_WEB_DIST`      | 构建后的 Web UI 资源路径。                                                                                         | 自动查找 `apps/web/dist` 或 `../web/dist` |
| `ROAMCLI_PUBLIC_ORIGIN` | 允许执行写操作的浏览器公开 origin，例如 `https://roam.example.com`。                                               | 根据请求 host 推断                        |
| `ROAMCLI_RESET_OWNER`   | 启动时设为 `1` 会清空 owner 凭据和 Web session，并生成新的 setup token。Runner token 和项目/session 数据保持不变。 | 未设置                                    |

## Runner 配置

Runner 会从 `<workspace>/<data-dir>/config.json` 读取本地配置。CLI 参数和环境变量会覆盖本地配置，并在 Runner 连接前写回。

| CLI 参数         | 环境变量                | 说明                                                                                                           |
| ---------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| `--server`       | `ROAM_RUNNER_SERVER`    | Server WebSocket URL。`http` 和 `https` 会转换为 `ws` 和 `wss`。                                               |
| `--token`        | `ROAM_RUNNER_TOKEN`     | Account & Security 中展示的 Runner token。                                                                     |
| `--runner-id`    | `ROAM_RUNNER_ID`        | 稳定 Runner 标识。默认是 hostname 加生成的 UUID。                                                              |
| `--workspace`    | `ROAM_RUNNER_WORKSPACE` | 暴露给 RoamCli Session 的 workspace 根目录。默认是当前目录。                                                   |
| `--data-dir`     | `ROAM_RUNNER_DATA_DIR`  | workspace 下的相对 Runner 数据目录，用于状态和 session worktree。默认 `.roam-runner`，拒绝绝对路径和父级跳转。 |
| `--profile`      | `ROAM_RUNNER_PROFILE`   | Runner profile：`strict`、`standard` 或 `trusted`。默认是 `standard`。                                         |
| `--agent-plugin` | `ROAMCLI_AGENT_PLUGINS` | 必填的 Agent 插件包。CLI 可重复传入，环境变量用逗号分隔。                                                      |

## Agent 插件

Runner 核心保持极简，不会默认加载任何 Agent 插件。你必须通过 `--agent-plugin` 或 `ROAMCLI_AGENT_PLUGINS` 选择至少一个插件；使用 `npx` 时，每个插件也要用 `--package` 提供。

官方插件包：

- `@roamcli/agent-codex`
- `@roamcli/agent-claude-code`

可以同时加载多个插件：

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  --package @roamcli/agent-claude-code \
  -- roam-runner \
  --server ws://127.0.0.1:8787/v1/runner \
  --token <runner-token> \
  --agent-plugin @roamcli/agent-codex \
  --agent-plugin @roamcli/agent-claude-code
```

如果要固定旧版 Runner/插件，在 `--package` 值上加 npm 版本，例如 `@roamcli/runner@1.1.0`。Runner 本地配置只保存插件 import name，不保存 package 版本。

Codex 插件默认使用 `codex app-server --stdio -c skip_git_repo_check=true`。Codex 命令可以通过以下环境变量覆盖：

```text
ROAMCLI_AGENT_CODEX_COMMAND
```

当 Runner 需要启动指定 Codex 二进制或包装脚本时使用 `ROAMCLI_AGENT_CODEX_COMMAND`。App-server 参数固定为 stdio transport 路径。

旧的 `codex exec --json` 调用方式只在显式选择后可用：

```text
ROAMCLI_AGENT_CODEX_MODE=exec-json
ROAMCLI_AGENT_CODEX_ARGS
```

`ROAMCLI_AGENT_CODEX_ARGS` 只在 `exec-json` 模式生效，支持类 shell 字符串，也支持 JSON 字符串数组。

## Docker Compose

仓库根目录的 `docker-compose.yml` 面向源码 checkout。它只会启动 Server；你仍然需要单独启动一个或多个 Runner，并让它们连接到 Server。Release 下载只需要 `install-server.sh`；安装脚本会在本地生成 Compose 文件。

```bash
docker compose up --build
```

compose 配置会把 Server 暴露在 `8787` 端口，并把 Server 数据持久化到 `roamcli-data` volume。

连接 compose Server 的 Runner 示例：

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner \
  --server ws://127.0.0.1:8787/v1/runner \
  --token <runner-token-from-account-security> \
  --agent-plugin @roamcli/agent-codex
```

之后在同一 workspace 启动时可以使用已持久化的本地配置：

```bash
npx --yes \
  --package @roamcli/runner \
  --package @roamcli/agent-codex \
  -- roam-runner
```

## 仓库结构

```text
apps/server       Fastify API、WebSocket hub、持久化、artifacts、静态 Web 托管。
apps/runner       Runner CLI、Agent 进程管理、workspace 文件操作。
apps/web          React 浏览器客户端。
packages/shared   共享协议 schema/类型，以及 Node 侧安全辅助函数。
packages/agent-*  Agent 插件 SDK 和内置 Codex 插件。
```

## 许可证

RoamCli 使用 EESPL 2.0 许可证。见 [LICENSE](LICENSE)。
