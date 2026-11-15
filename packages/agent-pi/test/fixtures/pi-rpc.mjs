import fs from "node:fs";
import path from "node:path";
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const sessionFile = process.argv.includes("--session")
  ? arg("--session")
  : path.join(process.cwd(), "native-session.jsonl");
const model = {
  provider: process.argv.includes("--provider")
    ? arg("--provider")
    : "provider-a",
  id: process.argv.includes("--model") ? arg("--model") : "model",
  name: "Model",
  reasoning: true,
  input: ["text", "image"],
  thinkingLevelMap: { off: null, minimal: "low", xhigh: "xhigh", max: null },
};
const savedEntries = fs.existsSync(sessionFile)
  ? fs
      .readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
  : [];
const header = savedEntries[0] ?? {
  type: "session",
  version: 3,
  cwd: process.cwd(),
  id: "native-id",
  timestamp: "2026-11-15T00:00:00.000Z",
};
const entries = savedEntries.length
  ? savedEntries.slice(1)
  : [
      {
        type: "model_change",
        id: "model-1",
        parentId: null,
        timestamp: "2026-11-15T00:00:00.000Z",
        provider: model.provider,
        modelId: model.id,
      },
    ];
let flushed = process.argv.includes("--session") && savedEntries.length > 0;
const persistConversation = (text) => {
  entries.push({
    type: "message",
    id: `message-${entries.length}`,
    parentId: entries.at(-1)?.id ?? null,
    timestamp: "2026-11-15T00:00:00.000Z",
    message: { role: "user", content: [{ type: "text", text }] },
  });
  if (!flushed) {
    // Match Pi's native first-conversation write: an adapter-created file in
    // an active process must not silently conceal an EEXIST collision.
    fs.writeFileSync(
      sessionFile,
      [header, ...entries].map((entry) => JSON.stringify(entry)).join("\n") +
        "\n",
      { flag: "wx" },
    );
    flushed = true;
  } else {
    fs.appendFileSync(sessionFile, JSON.stringify(entries.at(-1)) + "\n");
  }
};
const sendReady = () => {
  if (
    process.argv.includes("--extension") &&
    process.env.PI_TEST_NO_BRIDGE !== "1"
  )
    send({
      type: "extension_ui_request",
      method: "notify",
      message: `roamcli-ready:${process.env.ROAMCLI_PI_APPROVAL_TOKEN}`,
    });
};
let startupUI = process.env.PI_TEST_STARTUP_UI === "1";
if (startupUI)
  send({
    type: "extension_ui_request",
    id: "startup-ui",
    method: "input",
    title: "Startup question",
    placeholder: "Continue initialization?",
  });
else sendReady();
let active = false;
let pendingApproval;
let pendingDialog;
let pendingStartupState;
let pendingTransport;
let rejectedOnce = false;
let buffer = "";
const respond = (command, data, success = true) =>
  send({
    id: command.id,
    type: "response",
    command: command.type,
    success,
    data,
    error: success ? undefined : "rejected before acceptance",
  });
const finish = (text, aborted = false) => {
  send({
    type: "message_update",
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "partial ",
    },
  });
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  });
  send({ type: "agent_end", willRetry: false });
  send({ type: "agent_settled", aborted });
  active = false;
};
process.stdin.setEncoding("utf8");
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (process.env.PI_TEST_LOG)
      fs.appendFileSync(
        process.env.PI_TEST_LOG,
        JSON.stringify(command) + "\n",
      );
    if (command.type === "get_state") {
      const state = () =>
        respond(command, {
          model,
          sessionId: "native-id",
          sessionFile,
          isStreaming: active,
          thinkingLevel: "medium",
        });
      if (startupUI) pendingStartupState = state;
      else state();
    } else if (command.type === "get_available_thinking_levels")
      respond(command, {
        levels: ["minimal", "low", "medium", "high", "xhigh"],
      });
    else if (command.type === "get_available_models")
      respond(command, {
        models: [
          model,
          {
            ...model,
            provider: "custom/provider",
            id: "org/model",
            reasoning: false,
          },
        ],
      });
    else if (command.type === "get_commands")
      respond(command, {
        commands: [
          {
            name: "skill:review",
            source: "skill",
            description: "Review",
            sourceInfo: {
              path: "/project/.pi/skills/review/SKILL.md",
              scope: "project",
            },
          },
          {
            name: "skill:global",
            source: "skill",
            sourceInfo: {
              path: "/home/.pi/skills/global/SKILL.md",
              scope: "user",
            },
          },
          { name: "extension", source: "extension" },
        ],
      });
    else if (command.type === "prompt") {
      if (
        command.message === "reject" ||
        (command.message === "reject-once" && !rejectedOnce)
      ) {
        rejectedOnce = true;
        respond(command, {}, false);
        continue;
      }
      if (
        command.message ===
        `/roamcli-state-${process.env.ROAMCLI_PI_APPROVAL_TOKEN}`
      ) {
        send({
          type: "extension_ui_request",
          method: "notify",
          message: `roamcli-snapshot:${process.env.ROAMCLI_PI_APPROVAL_TOKEN}:${JSON.stringify({ header, entries })}`,
        });
        respond(command, { disposition: "handled" });
        continue;
      }
      if (command.message === "handled-empty") {
        respond(command, { disposition: "handled" });
        continue;
      }
      if (command.message.startsWith("dialog:")) {
        const method = command.message.slice("dialog:".length);
        send({
          type: "extension_ui_request",
          id: "user-dialog",
          method,
          title: "Extension question",
          message: "Confirm this action?",
          placeholder: "输入中文回答",
          prefill: "existing editor text",
          options: ["甲", "乙"],
        });
        pendingDialog = (response) => {
          send({
            type: "extension_ui_request",
            method: "notify",
            message: `dialog answer: ${JSON.stringify(response)}`,
          });
          respond(command, { disposition: "handled" });
        };
        continue;
      }
      persistConversation(command.message);
      active = true;
      send({ type: "agent_start" });
      send({
        type: "message_start",
        message: { role: "assistant", content: [] },
      });
      if (command.message === "before-ack") {
        finish("Unicode\u2028正文\u2029done");
        setTimeout(() => respond(command, { disposition: "started" }), 20);
      } else {
        respond(command, { disposition: "started" });
        if (command.message === "wait") continue;
        if (command.message === "crash") {
          process.exit(9);
        } else if (command.message === "write") {
          const input = { path: "result.txt", content: "approved write" };
          send({
            type: "tool_execution_start",
            toolCallId: "write-1",
            toolName: "write",
            args: input,
          });
          send({
            type: "extension_ui_request",
            id: "approval-1",
            method: "confirm",
            title: `roamcli-approval:${process.env.ROAMCLI_PI_APPROVAL_TOKEN}`,
            message: JSON.stringify({ toolName: "write", input }),
          });
          pendingApproval = () => {};
          pendingApproval = (confirmed) => {
            if (confirmed)
              fs.writeFileSync(
                path.join(process.cwd(), "result.txt"),
                input.content,
              );
            send({
              type: "tool_execution_end",
              toolCallId: "write-1",
              toolName: "write",
              isError: !confirmed,
              result: {
                content: [
                  { type: "text", text: confirmed ? "written" : "denied" },
                ],
              },
            });
            finish(confirmed ? "Written" : "Denied");
          };
        } else if (command.message === "retry") {
          send({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "retryable",
              content: [],
            },
          });
          send({ type: "agent_end", willRetry: true });
          setTimeout(() => {
            send({ type: "agent_start" });
            finish("Recovered");
          }, 30);
        } else if (command.message === "failure") {
          send({
            type: "message_end",
            message: {
              role: "assistant",
              stopReason: "error",
              errorMessage: "provider failed",
              content: [],
            },
          });
          send({ type: "agent_settled", aborted: false });
        } else finish(command.message);
      }
    } else if (command.type === "extension_ui_response") {
      if (command.id === "startup-ui") {
        startupUI = false;
        sendReady();
        pendingStartupState?.();
        pendingStartupState = undefined;
      } else if (command.id === "user-dialog") {
        pendingDialog?.(command);
        pendingDialog = undefined;
      } else if (command.id === "transport-dialog") {
        pendingTransport?.();
        pendingTransport = undefined;
      } else {
        pendingApproval?.(command.confirmed === true);
        pendingApproval = undefined;
      }
    } else if (command.type === "clear_queue")
      respond(command, { steering: [], followUp: [] });
    else if (command.type === "abort") {
      send({ type: "agent_settled", aborted: true });
      respond(command);
    } else if (command.type === "wait_for_user") {
      pendingTransport = () => respond(command, { accepted: true });
      send({
        type: "extension_ui_request",
        id: "transport-dialog",
        method: "input",
        title: "Wait before responding",
      });
    } else if (command.type !== "never_respond") respond(command);
  }
});
