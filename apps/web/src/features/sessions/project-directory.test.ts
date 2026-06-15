import { describe, expect, it } from "vitest";
import {
  composeProjectDirectory,
  projectDirectoryName,
  validateProjectDirectorySuffix,
} from "./project-directory";

describe("project directory helpers", () => {
  it("composes runner base and relative suffixes", () => {
    expect(composeProjectDirectory("/workspace", "kaboo")).toBe(
      "/workspace/kaboo",
    );
    expect(composeProjectDirectory("/workspace/", "team/kaboo/")).toBe(
      "/workspace/team/kaboo",
    );
  });

  it("keeps an empty suffix at the runner base", () => {
    expect(composeProjectDirectory("/workspace", "")).toBe("/workspace");
    expect(composeProjectDirectory("/", "")).toBe("/");
    expect(composeProjectDirectory("/", "kaboo")).toBe("/kaboo");
  });

  it("rejects absolute paths and traversal segments", () => {
    expect(validateProjectDirectorySuffix("/tmp/kaboo")).toMatchObject({
      ok: false,
      message: "Directory must stay under the runner base.",
    });
    expect(validateProjectDirectorySuffix("../kaboo")).toMatchObject({
      ok: false,
      message: "Directory must stay under the runner base.",
    });
    expect(validateProjectDirectorySuffix("team/./kaboo")).toMatchObject({
      ok: false,
      message: "Directory must stay under the runner base.",
    });
  });

  it("derives names from composed directories", () => {
    expect(projectDirectoryName("/workspace/kaboo")).toBe("kaboo");
    expect(projectDirectoryName("/workspace/")).toBe("workspace");
    expect(projectDirectoryName("/")).toBe("/");
  });
});
