import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { piInvocation } from "./command.js";

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "roam pi command "));
  temporary.push(path);
  return path;
}

async function npmInstall(binDirectory: string, scope = "@earendil-works") {
  const root = join(binDirectory, "node_modules", scope, "pi-coding-agent");
  await mkdir(root, { recursive: true });
  const cli = join(root, "cli.js");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ bin: { pi: "cli.js" } }),
  );
  await writeFile(
    cli,
    "console.log(JSON.stringify(process.argv.slice(2)));\n",
  );
  return cli;
}

async function managedInstall(agentDirectory: string, version = "1.5.2") {
  const bin = join(agentDirectory, "bin");
  const root = join(agentDirectory, "install");
  const release = join(root, "releases", version);
  await mkdir(bin, { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    join(bin, "pi-launcher.js"),
    "// Official managed launcher location\n",
  );
  await writeFile(join(bin, "pi.cmd"), "@node pi-launcher.js %*\r\n");
  await writeFile(join(bin, "pi.ps1"), "& node pi-launcher.js @args\n");
  await writeFile(join(root, "current-version"), `${version}\r\n`);
  return { bin, root, cli: await npmInstall(release) };
}

describe("Pi command discovery", () => {
  it("resolves the active official Windows managed release directly without a wrapper process", async () => {
    const managed = await managedInstall(await directory());
    const invocation = piInvocation("pi", { Path: managed.bin }, "win32");
    expect(invocation).toEqual({
      command: process.execPath,
      args: [managed.cli],
    });
    const argument = "text & $(echo shell) | punctuation";
    const { stdout } = await promisify(execFile)(
      invocation.command,
      [...invocation.args, argument],
      { windowsHide: true },
    );
    expect(JSON.parse(stdout)).toEqual([argument]);
  });

  it("resolves current-version again after a native managed update", async () => {
    const agentDirectory = await directory();
    const first = await managedInstall(agentDirectory);
    expect(piInvocation("pi", { PATH: first.bin }, "win32").args).toEqual([
      first.cli,
    ]);
    const next = await managedInstall(agentDirectory, "1.5.3");
    expect(piInvocation("pi", { PATH: next.bin }, "win32").args).toEqual([
      next.cli,
    ]);
  });

  it.each(["managed", "npm", "exe"])(
    "preserves PATH order when %s is first",
    async (first) => {
      const base = await directory();
      const managed = await managedInstall(join(base, "managed"));
      const npm = join(base, "npm");
      const npmCli = await npmInstall(npm);
      const exe = join(base, "exe");
      await mkdir(exe);
      await writeFile(join(exe, "pi.exe"), "");
      const entries = { managed: managed.bin, npm, exe };
      const order = [
        first,
        ...Object.keys(entries).filter((name) => name !== first),
      ];
      const path = order
        .map((name) => entries[name as keyof typeof entries])
        .join(";");
      expect(piInvocation("pi", { PATH: path }, "win32")).toEqual(
        first === "exe"
          ? { command: join(exe, "pi.exe"), args: [] }
          : {
              command: process.execPath,
              args: [first === "npm" ? npmCli : managed.cli],
            },
      );
    },
  );

  it.each(["pi.cmd", "pi.ps1"])(
    "resolves explicit managed %s paths before PATH",
    async (name) => {
      const base = await directory();
      const managed = await managedInstall(join(base, "managed"));
      const other = join(base, "other");
      await npmInstall(other);
      expect(
        piInvocation(join(managed.bin, name), { PATH: other }, "win32"),
      ).toEqual({ command: process.execPath, args: [managed.cli] });
    },
  );

  it("keeps an executable ahead of script installations in the same PATH directory", async () => {
    const managed = await managedInstall(await directory());
    await writeFile(join(managed.bin, "pi.exe"), "");
    expect(piInvocation("pi", { PATH: managed.bin }, "win32")).toEqual({
      command: join(managed.bin, "pi.exe"),
      args: [],
    });
  });

  it.each(["@earendil-works", "@mariozechner"])(
    "keeps %s npm installations working",
    async (scope) => {
      const bin = await directory();
      const cli = await npmInstall(bin, scope);
      expect(piInvocation("pi", { PATH: bin }, "win32")).toEqual({
        command: process.execPath,
        args: [cli],
      });
    },
  );

  it("reports a broken first managed installation instead of selecting a different Pi later in PATH", async () => {
    const base = await directory();
    const managed = await managedInstall(join(base, "managed"));
    const other = join(base, "other");
    await npmInstall(other);
    await writeFile(join(managed.root, "current-version"), "../outside");
    expect(() =>
      piInvocation("pi", { PATH: `${managed.bin};${other}` }, "win32"),
    ).toThrow(/managed Pi/i);
  });

  it("rejects a managed package entry that escapes its release package", async () => {
    const managed = await managedInstall(await directory());
    await writeFile(
      join(managed.cli, "..", "package.json"),
      JSON.stringify({ bin: { pi: "../outside.js" } }),
    );
    await writeFile(join(managed.cli, "..", "..", "outside.js"), "");
    expect(() =>
      piInvocation("pi", { PATH: managed.bin }, "win32"),
    ).toThrow(/managed Pi/i);
  });

  it("leaves explicit JavaScript/executable entries and Unix commands unchanged", () => {
    expect(piInvocation("/native/pi.mjs", {}, "win32")).toEqual({
      command: process.execPath,
      args: ["/native/pi.mjs"],
    });
    expect(piInvocation("C:\\native\\pi.exe", {}, "win32")).toEqual({
      command: "C:\\native\\pi.exe",
      args: [],
    });
    expect(piInvocation("pi", {}, "linux")).toEqual({
      command: "pi",
      args: [],
    });
  });
});
