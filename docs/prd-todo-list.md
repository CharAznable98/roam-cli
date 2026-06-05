# RoamCli PRD TODO List

本文档按 PRD 功能点逐项核对当前仓库实现状态。

状态说明：

- [x] 已实现：已有代码路径，且已纳入 `pnpm typecheck` / `pnpm test` / `pnpm build` 验证。
- [~] 部分实现：已有骨架或局部能力，但还不能完整满足 PRD 的产品语义。
- [ ] 未实现：当前仓库没有对应可用实现。

最后核对时间：2026-06-05

## 1. Monorepo 与共享层

- [x] pnpm workspace 单仓结构：`apps/server`、`apps/runner`、`apps/web`、`packages/*`。
- [x] TypeScript 严格配置与统一构建脚本。
- [x] 共享协议包 `@roamcli/protocol`：Runner、Session、Message、Approval、Artifact、WebSocket 事件、HTTP payload 的 Zod schema 与 TS 类型。
- [x] Parser SDK 包 `@roamcli/parser-sdk`：parser 接口、registry、基础行解析器、mock/shell/claude/codex/gemini/aider 默认 parser。
- [x] Security 包 `@roamcli/security`：X25519 密钥协商、AES-256-GCM JSON 加密、审批签名、审计 hash chain。
- [~] 跨端协议版本治理：已有 schema，但还没有协议版本协商、兼容策略、迁移测试。
- [ ] 独立 npm parser 包发布形态：目前是 monorepo 内部包，尚未拆成社区可贡献的 `@roamcli/parser-*` 模板和发布流程。

## 2. Server 中心服务端

- [x] Fastify Server 框架。
- [x] token 鉴权骨架：`Authorization: Bearer <token>` 或 query token。
- [x] `GET /v1/sessions`。
- [x] `GET /v1/runners`。
- [x] `POST /v1/sessions`。
- [x] `GET /v1/sessions/:id`。
- [x] `GET /v1/sessions/:id/files`：Server 通过 Runner RPC 获取真实工作区文件树。
- [x] `GET /v1/sessions/:id/files/content`：Server 通过 Runner RPC 获取真实文件内容。
- [x] `POST /v1/sessions/:id/patches/apply`：Server 校验签名后通过 Runner RPC 应用 unified diff。
- [x] `POST /v1/approvals/:id`。
- [x] `POST /v1/artifacts`。
- [x] `WSS /v1/stream` 客户端事件流。
- [x] `WSS /v1/runner` Runner 反向长连接。
- [x] Runner 注册、在线状态、断开离线标记。
- [x] Client 到 Runner 的消息路由。
- [x] Runner 到 Client 的事件广播。
- [x] SQLite 持久化：sessions、messages、approvals、artifacts、runners。
- [x] 本地 FS artifact 存储。
- [x] Web dist 静态托管。
- [x] Dockerfile 与 `docker-compose.yml` 基础部署。
- [~] 本地账号体系：只有单 token 鉴权，尚未实现账号、密码、session cookie、用户维度资源隔离。
- [~] 会话 CRUD：已有创建和读取，尚未实现显式更新、停止、归档、删除、搜索。
- [~] 审批签名链：Server 已校验 HMAC 签名并拒绝无效签名；仍未把签名校验结果绑定到不可篡改审计链。
- [~] E2E 加密：共享包有加密能力，Server 事件流仍主要转发明文，尚未接入 Runner/Client 端到端密文协议。
- [~] 审计：Runner 有本地审计，Server 尚未实现中心审计视图或审计查询接口。
- [~] 产物上传：支持 base64/text 上传与本地落盘，尚未支持对象存储直传、S3 兼容、增量 diff、大文件分片。
- [~] 静态部署：本地可用，生产 HTTPS / 反代文档尚未补齐。
- [ ] OIDC 接入。
- [ ] Runner 注册白名单和指纹准入。
- [ ] 审批双人复核策略。
- [ ] 会话产物加密落盘。
- [ ] 匿名遥测开关和社区指标采集。

## 3. Agent Runner

- [x] Node CLI wrapper 应用。
- [x] CLI 参数：`--server`、`--token`、`--profile`、`--runner-id`、`--workspace`。
- [x] Runner 自注册。
- [x] 反向 WebSocket 连接。
- [x] 指数退避重连。
- [x] 断线事件本地缓存与重连 drain。
- [x] capabilities 注册：claude、codex、gemini、aider、mock、shell。
- [x] spawn 子进程。
- [x] stdin/stdout/stderr 接管。
- [x] ANSI 输出清理与基础流式 token 解析。
- [x] 工具审批 marker 解析与上报。
- [x] approval response 注入子进程。
- [x] control signal：interrupt、stop、resume。
- [x] strict/standard/trusted 权限模板定义。
- [x] 工作目录边界检查，阻止 cwd 逃逸 workspace。
- [x] append-only JSONL 审计 hash chain。
- [x] artifact sha256 计算。
- [x] PTY 接管：优先使用 `node-pty`，不可用时回退 `child_process.spawn` pipe。
- [x] 工作区文件树读取：Runner 通过 realpath 边界检查读取 session cwd 内文件树，并跳过 `.git`、`node_modules`、`dist` 等生成目录。
- [x] 工作区文件内容读取：Runner 支持按 `maxBytes` 截断读取 UTF-8 文件内容，并阻止路径逃逸。
- [x] Patch apply：Runner 在 session cwd 内执行 signed unified diff apply，预检查路径并阻止 workspace/session cwd 逃逸。
- [~] Agent parser：当前是基础 marker/line parser，尚未实现 Claude/Codex/Gemini/Aider 的真实输出边界、工具调用、错误码和版本快照。
- [~] 权限模板执行：已有模板和 cwd 边界，但未真正拦截网络出站、命令白名单、文件读写策略。
- [~] 会话恢复：支持 `resume` 控制消息注入，但未对接 Codex rollout、Claude `--resume` 等 Agent 原生恢复机制。
- [~] 本地审计导出：有 JSONL 记录与 hash chain，尚未实现 `roamcli audit export` 命令。
- [~] artifact 同步：Runner 可生成 artifact event，Server 也有上传接口，但两端尚未形成真实文件上传闭环。
- [ ] macOS Keychain / Linux secret-service / Windows DPAPI 密钥隔离。
- [ ] 沙箱执行。
- [ ] 工具白名单审批策略。
- [ ] 大 patch / 大文件增量传输。

## 4. Web Client

- [x] React + Vite + Tailwind 应用。
- [x] 同源 Web App，可由 Server 托管。
- [x] Mobile 单栏布局。
- [x] Mobile 底部 Tab：对话、文件、终端、审批。
- [x] Tablet 两栏布局。
- [x] Desktop 三栏布局。
- [x] Runner 列表与 Runner 切换 UI。
- [x] Session 列表与 Session 切换 UI。
- [x] 新会话表单 UI。
- [x] 对话流 UI。
- [x] 思考过程 / 工具调用折叠 UI。
- [x] 审批中心 UI。
- [x] 文件树 + MVP 文本编辑器 UI。
- [x] Patch hunk 接受 / 拒绝 UI。
- [x] 终端面板 UI。
- [x] PWA manifest。
- [x] Service Worker 注册。
- [x] Web Push 设置占位。
- [x] SpeechRecognition feature-detect 语音按钮。
- [x] API 集成：Web 启动时读取 `/v1/runners`、`/v1/sessions`、`/v1/sessions/:id`，创建会话走 `POST /v1/sessions`，审批走 `POST /v1/approvals/:id`。
- [x] WebSocket 事件订阅：Web 连接 `/v1/stream` 并消费 runner、session、message、token、terminal、approval、artifact 事件。
- [x] 对话流：已消费真实 streaming token，并在 Server 侧持久化 token 历史。
- [x] 文件浏览：Web 从 `/v1/sessions/:id/files` 加载真实 Runner 文件树，点击文件后从 `/files/content` 加载真实内容。
- [x] 编辑器 MVP：Web 可编辑已加载 UTF-8 文本文件，支持 dirty/saved/error 状态、保存按钮和 Cmd/Ctrl+S；保存经 Server RPC 写入真实 Runner session cwd 内已有文件。
- [x] Patch 审查：支持 hunk accept/reject 本地决策，Apply 时生成 signed unified diff 并调用真实 Server/Runner apply 链路。
- [~] 终端面板：已显示真实 `terminal:data` 事件流并可发送输入到 active session；Runner 端有 PTY，Web 端做了 ANSI 清理与 1000 行历史上限；尚未接入 xterm.js、尺寸同步和服务端终端历史持久化。
- [~] 移动端终端只读降级：UI 上可表达，但尚未做真实设备验证和复制流程。
- [~] Web Push：只有 UI/manifest/service worker 占位，尚未实现 Push subscription、VAPID、服务端通知。
- [~] 语音输入：有 feature detection 按钮，尚未把语音识别结果写入输入框。
- [ ] 客户端 E2E 加密会话密钥协商。
- [~] 审批签名生成与私钥管理：Web 已生成 HMAC 审批与 patch apply 签名；缺浏览器私钥隔离、密钥轮换和设备级密钥管理。
- [ ] 多客户端同会话并发视图一致性。
- [ ] 三档断点截图回归测试。

## 5. Phase 0 PRD 核对

- [~] Server 框架：鉴权、会话 CRUD、Runner 反向 WSS、消息路由。
  - 已实现鉴权骨架、创建/读取会话、Runner WSS、消息路由。
  - 缺完整 CRUD、用户体系、停止/归档等会话生命周期能力。
- [~] Runner CLI Wrapper：spawn Claude Code、PTY 接管、输出解析。
  - 已实现通用 spawn、`node-pty` 优先接管和基础解析。
  - 已补 Claude/Codex/Gemini/Aider 真实-ish fixture 回放；缺真实 CLI 录制样本和各 Agent 完整原生事件协议。
- [~] Web Client 骨架：响应式布局 + 对话视图。
  - 已实现响应式 UI 和对话视图。
  - 已接入真实 Server API / WSS。
- [x] SQLite 持久化 + 本地 FS 产物。
- [x] docker-compose 一键起基础文件。

## 6. Phase 1 PRD 核对

- [~] 公网部署文档 + HTTPS / 反代。
  - 有 Dockerfile 和 compose。
  - 缺 Nginx/Caddy/Traefik、HTTPS、域名、生产 hardening 文档。
- [~] 审批中心：execCommand / applyPatch。
  - applyPatch 已有签名校验和真实 Runner apply 链路。
  - execCommand 仍缺真实工具桥接、签名执行策略和策略引擎。
- [~] 文件树 + Monaco 只读浏览 + Patch 高亮。
  - 已有真实文件树、真实文件内容读取和 MVP 文本保存。
  - 缺 Monaco/CodeMirror、语法高亮、patch 高亮。
- [~] PWA + Web Push。
  - 有 manifest、SW、Push UI。
  - 缺真实 push subscription 和通知发送。
- [~] 移动端响应式样式打磨。
  - 有断点和移动 UI。
  - 缺真实设备截图回归、键盘遮挡治理验证。
- [x] Runner 断线重连与事件续传基础。

## 7. Phase 2 PRD 核对

- [~] CLI Wrapper 适配 Codex / Gemini / Aider。
  - capabilities、基础 parser 和 Claude/Codex/Gemini/Aider fixture 回放测试已有。
  - 缺真实命令模板、真实 CLI 录制 fixture 和完整原生事件协议 parser。
- [~] Monaco 在线编辑 + Patch 双向审查。
  - MVP 文本编辑保存、Patch hunk accept/reject 和 signed apply 已可用。
  - 缺 Monaco、语法服务、编辑后接受、patch 高亮和冲突处理。
- [~] 嵌入式终端面板 xterm.js。
  - Runner 端已有 PTY，Web 端有实时终端流和输入。
  - 缺 xterm.js、终端尺寸同步、终端历史持久化。
- [~] 多 Runner 切换与跨机会话接力。
  - 有 Runner 注册、在线列表、UI 切换。
  - 缺跨 Runner 迁移会话状态、Agent 原生 resume、产物接力。
- [~] Agent 适配文档与模板。
  - 有 parser SDK 和四类 Agent fixture 回放测试。
  - 缺贡献模板、真实录制 fixture、CI 回放矩阵和文档。

## 8. Phase 3 PRD 核对

- [~] 语音输入。
  - 有按钮和 feature detection。
  - 缺识别结果落入输入框。
- [~] 底部输入栏、键盘遮挡治理。
  - 有移动布局。
  - 缺软键盘可用性专项实现和设备验证。
- [ ] 触控手势、长按菜单。
- [ ] 多 Runner 并行任务面板。
- [ ] 会话归档与全文检索。
- [ ] 可选 OIDC 接入。

## 9. 安全模型核对

- [~] Runner ↔ Server / Runner ↔ Client E2E 加密。
  - 共享包已有 X25519 + AES-GCM primitives。
  - 缺端到端握手、密文事件协议、密钥轮换、客户端持钥。
- [~] 审批签名链。
  - Web 生成 HMAC 签名，Server 校验审批和 patch apply 签名，Runner 已对 patch apply 做二次验签。
  - 缺签名时效/重放窗口、密钥隔离和不可篡改审计联动。
- [~] 最小权限模板。
  - Runner 有 strict/standard/trusted profile 和 cwd 边界。
  - 缺网络隔离、命令策略、系统沙箱。
- [ ] 密钥隔离：Keychain / secret-service / DPAPI。
- [~] 本地审计日志。
  - Runner 有 append-only JSONL hash chain。
  - 缺导出命令、查询工具、SIEM 格式适配。
- [ ] 企业 OIDC。
- [ ] Runner 注册白名单。
- [ ] 会话产物加密落盘。
- [ ] 高危操作双人审批。

## 10. 测试与质量门禁

- [x] 全仓类型检查：`pnpm typecheck`。
- [x] 全仓单元测试：`pnpm test`，当前 16 files / 60 tests。
- [x] 全仓生产构建：`pnpm build`。
- [x] Server API 基础测试。
- [x] Runner CLI、parser、connection、audit/cache、artifact 测试。
- [x] Web layout 与 App smoke 测试。
- [x] 自动化 smoke/E2E：`pnpm smoke:e2e` 启动真实 Server + Runner，覆盖 runner online、create session、token 持久化、file tree/content、真实文件编辑保存、terminal input、坏 patch 签名拒绝、signed patch apply。
- [ ] Playwright 断点截图回归。
- [x] Parser fixture 回放测试：覆盖 Claude/Codex/Gemini/Aider 真实-ish transcript；仍需真实 CLI 录制样本。
- [ ] Docker build CI 测试。
- [~] 安全签名和 E2E 加密端到端测试：审批/patch 签名、Server 校验、Runner patch 二次验签和坏签名 smoke 已覆盖；E2E 加密协议尚未接入。
- [ ] 大文件 artifact 压测。

## 11. 建议后续 Issue 切分

1. Web xterm.js integration：接入 xterm.js、终端尺寸同步、终端历史持久化。
2. Real parser adapters：用真实 CLI 录制样本替换/补充 Claude/Codex/Gemini/Aider 真实-ish fixture，并完善原生事件协议 parser。
3. E2E encryption protocol：Client/Runner 握手、密文消息、Server 只转发密文。
4. Approval signing hardening：Runner patch apply 二次校验已落地；仍需密钥隔离、审计 hash chain 绑定审批。
5. Editor polish：MVP 文本保存已落地；后续接 Monaco/CodeMirror、语法高亮、冲突处理。
6. Patch review polish：patch 高亮、冲突处理、编辑后 accept、失败回滚提示。
7. Production deployment docs：HTTPS、反代、token/OIDC、数据目录、备份恢复。
8. Mobile hardening：键盘遮挡、触控手势、长按菜单、三断点截图回归。
9. Audit export CLI：`roamcli audit export`，输出 JSONL/NDJSON/SIEM friendly format。
