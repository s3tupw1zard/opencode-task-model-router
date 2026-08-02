import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SMOKE_MODEL_ERROR =
  'OPENCODE_SMOKE_MODEL is required for live smoke tests. Set it to an available OpenCode model ID, for example: OPENCODE_SMOKE_MODEL="provider/model-id" npm run smoke';

export function requireSmokeModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = env.OPENCODE_SMOKE_MODEL;
  if (!model?.trim()) throw new Error(SMOKE_MODEL_ERROR);
  return model;
}

export function createSmokeConfig(
  testName: string,
  pluginPath: string,
): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(
    join(tmpdir(), `opencode-task-model-router-${testName}-`),
  );
  const path = join(directory, "opencode.json");
  const modelOverridePath = join(directory, "smoke-model-plugin.mjs");
  try {
    writeFileSync(
      modelOverridePath,
      `export default async () => ({
  config(config) {
    const model = process.env.OPENCODE_SMOKE_MODEL;
    if (!model) return;
    for (const agent of Object.values(config.agent ?? {})) {
      if (!agent || typeof agent !== "object") continue;
      agent.model = model;
      delete agent.variant;
      delete agent.options;
    }
  },
  "chat.message": async (_input, output) => {
    const model = process.env.OPENCODE_SMOKE_MODEL;
    const separator = model?.indexOf("/") ?? -1;
    if (!output?.message || separator <= 0 || separator === model.length - 1) return;
    output.message.model = {
      providerID: model.slice(0, separator),
      modelID: model.slice(separator + 1),
    };
  },
});
`,
      "utf8",
    );
    writeFileSync(
      path,
      JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          plugin: [pluginPath, modelOverridePath],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

export interface OpenCodeRunOptions {
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  command?: string;
  timeoutMs?: number;
  killGraceMs?: number;
  maxBuffer?: number;
}

export interface OpenCodeRunResult {
  pid?: number;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  elapsedMs: number;
  timedOut: boolean;
  overflowed: boolean;
  spawnError?: Error;
}

function smokeChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key]) => key !== "VITEST" && !key.startsWith("VITEST_"),
    ),
  );
}

export async function runOpenCode(
  options: OpenCodeRunOptions,
): Promise<OpenCodeRunResult> {
  const timeoutMs = options.timeoutMs ?? 170_000;
  const killGraceMs = options.killGraceMs ?? 3_000;
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
  const startedAt = Date.now();
  const detached = process.platform !== "win32";
  const child = spawn(options.command ?? "opencode", options.args, {
    cwd: options.cwd,
    env: smokeChildEnv(options.env),
    detached,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let outputBytes = 0;
  let timedOut = false;
  let overflowed = false;
  let spawnError: Error | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let termination: Promise<void> | undefined;

  const signalProcessTree = (signal: NodeJS.Signals): boolean => {
    if (child.pid === undefined) return false;
    try {
      if (detached) process.kill(-child.pid, signal);
      else child.kill(signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        spawnError ??= error as Error;
      }
      return false;
    }
  };

  const processTreeExists = (): boolean => {
    if (child.pid === undefined) return false;
    try {
      if (detached) process.kill(-child.pid, 0);
      else process.kill(child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      spawnError ??= error as Error;
      return false;
    }
  };

  const waitForTreeExit = async (deadline: number): Promise<boolean> => {
    while (processTreeExists() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !processTreeExists();
  };

  const terminate = (): Promise<void> => {
    termination ??= (async () => {
      if (!signalProcessTree("SIGTERM")) return;
      if (await waitForTreeExit(Date.now() + killGraceMs)) return;
      signalProcessTree("SIGKILL");
      if (!(await waitForTreeExit(Date.now() + 1_000))) {
        spawnError ??= new Error("OpenCode process group did not terminate");
      }
    })();
    return termination;
  };

  const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
    outputBytes += chunk.byteLength;
    if (outputBytes <= maxBuffer) {
      if (target === "stdout") stdout += chunk.toString("utf8");
      else stderr += chunk.toString("utf8");
      return;
    }
    overflowed = true;
    void terminate();
  };

  const onStdout = (chunk: Buffer): void => collect("stdout", chunk);
  const onStderr = (chunk: Buffer): void => collect("stderr", chunk);
  const onError = (error: Error): void => {
    spawnError = error;
    void terminate();
  };
  const onExit = (): void => {
    // The CLI may leave descendants holding inherited pipes open.
    void terminate();
  };

  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);
  child.on("error", onError);
  child.on("exit", onExit);

  timeout = setTimeout(() => {
    timedOut = true;
    void terminate();
  }, timeoutMs);

  const { code, signal } = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });

  if (timeout) clearTimeout(timeout);
  await terminate();
  child.stdout.off("data", onStdout);
  child.stderr.off("data", onStderr);
  child.off("error", onError);
  child.off("exit", onExit);

  return {
    ...(child.pid === undefined ? {} : { pid: child.pid }),
    code,
    signal,
    stdout,
    stderr,
    elapsedMs: Date.now() - startedAt,
    timedOut,
    overflowed,
    ...(spawnError ? { spawnError } : {}),
  };
}
