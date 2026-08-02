import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  createSmokeConfig,
  requireSmokeModel,
  runOpenCode,
  SMOKE_MODEL_ERROR,
} from "../smoke/support";

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

describe("live smoke model configuration", () => {
  it.each([undefined, "", "   "])(
    "fails clearly when OPENCODE_SMOKE_MODEL is %j",
    (model) => {
      expect(() =>
        requireSmokeModel(
          model === undefined ? {} : { OPENCODE_SMOKE_MODEL: model },
        ),
      ).toThrow(SMOKE_MODEL_ERROR);
    },
  );

  it("returns the configured model ID unchanged", () => {
    const model = "  provider/model-id  ";
    expect(requireSmokeModel({ OPENCODE_SMOKE_MODEL: model })).toBe(model);
  });

  it("creates isolated configs and removes their temporary directories", async () => {
    const first = createSmokeConfig("first", "/plugin/index.ts");
    const second = createSmokeConfig("second", "/plugin/index.ts");
    const previousModel = process.env.OPENCODE_SMOKE_MODEL;
    try {
      expect(first.path).not.toBe(second.path);
      expect(first.path).not.toContain(process.cwd());
      const config = JSON.parse(readFileSync(first.path, "utf8")) as {
        plugin: string[];
      };
      expect(config.plugin[0]).toBe("/plugin/index.ts");
      expect(config.plugin[1]).toMatch(/smoke-model-plugin\.mjs$/u);

      process.env.OPENCODE_SMOKE_MODEL = "opencode/model/with-slash";
      const moduleUrl = `${pathToFileURL(config.plugin[1]!).href}?test=${Date.now()}`;
      const smokePlugin = (await import(moduleUrl)).default as () => Promise<{
        config: (config: Record<string, any>) => void;
        "chat.message": (
          input: unknown,
          output: Record<string, any>,
        ) => Promise<void>;
      }>;
      const hooks = await smokePlugin();
      const agents = {
        fast: { model: "old/fast", variant: "max", options: { old: true } },
        medium: {
          model: "old/medium",
          variant: "max",
          options: { old: true },
        },
        heavy: { model: "old/heavy" },
      };
      hooks.config({ agent: agents });
      expect(agents).toEqual({
        fast: { model: "opencode/model/with-slash" },
        medium: { model: "opencode/model/with-slash" },
        heavy: { model: "opencode/model/with-slash" },
      });

      const output = {
        message: {
          model: { providerID: "old", modelID: "medium" },
        },
      };
      await hooks["chat.message"]({}, output);
      expect(output.message.model).toEqual({
        providerID: "opencode",
        modelID: "model/with-slash",
      });
    } finally {
      if (previousModel === undefined) delete process.env.OPENCODE_SMOKE_MODEL;
      else process.env.OPENCODE_SMOKE_MODEL = previousModel;
      first.cleanup();
      second.cleanup();
    }
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });

  it("collects stdout and stderr after an asynchronous child closes", async () => {
    const result = await runOpenCode({
      command: process.execPath,
      args: [
        "-e",
        'process.stdout.write("out"); process.stderr.write("err");',
      ],
      cwd: tmpdir(),
      env: process.env,
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({
      code: 0,
      signal: null,
      stdout: "out",
      stderr: "err",
      timedOut: false,
      overflowed: false,
    });
    expect(result.spawnError).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "kills a timed-out process group and waits for close",
    async () => {
      const result = await runOpenCode({
        command: process.execPath,
        args: [
          "-e",
          'process.on("SIGTERM", () => {}); setInterval(() => {}, 1_000);',
        ],
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 50,
        killGraceMs: 50,
      });

      expect(result.timedOut).toBe(true);
      expect(result.signal).toBe("SIGKILL");
      expect(result.pid).toBeTypeOf("number");
      expect(processExists(result.pid!)).toBe(false);
    },
  );

  it.runIf(process.platform !== "win32")(
    "terminates descendants that keep inherited streams open",
    async () => {
      const script = [
        'const { spawn } = require("node:child_process");',
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
        "process.stdout.write(String(child.pid));",
        "child.unref();",
      ].join("\n");
      const result = await runOpenCode({
        command: process.execPath,
        args: ["-e", script],
        cwd: tmpdir(),
        env: process.env,
        timeoutMs: 2_000,
        killGraceMs: 50,
      });

      const descendantPid = Number(result.stdout);
      expect(result.code).toBe(0);
      expect(descendantPid).toBeGreaterThan(0);
      expect(processExists(descendantPid)).toBe(false);
    },
  );
});
