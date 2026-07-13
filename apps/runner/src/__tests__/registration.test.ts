import { describe, expect, it } from "vitest";
import { createRunnerRegistration } from "../bootstrap/registration.js";

describe("runner registration", () => {
  it("keeps the legacy public-key field while declaring signatures unsupported", () => {
    const registration = createRunnerRegistration({
      runnerId: "runner-1",
      workspace: "/workspace",
      dataDir: ".roam-runner",
      profile: "standard",
      capabilities: [
        {
          kind: "codex",
          label: "Codex",
          command: "codex",
          args: [],
          parser: "codex-app-server",
          supportsResume: true,
          supportsImages: false,
          supportedImageMimeTypes: [],
          maxImagesPerTurn: 0,
          maxImageBytes: 1024,
        },
      ],
    });

    expect(registration).toMatchObject({
      approvalSignatureMode: "unsupported",
    });
    expect(registration.publicKey).toMatch(/BEGIN PUBLIC KEY/);
  });
});
