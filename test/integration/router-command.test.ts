import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ModelRouterPlugin from "../../src/index";
import { resolveEnforcementMode } from "../../src/router/enforcement";
import {
  loadConfig,
  invalidateConfigCache,
  readState,
} from "../../src/router/config";

describe("router-command integration", () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let hooks: any;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let testHomeDir: string;

  beforeEach(async () => {
    // Redirect HOME/USERPROFILE so the real state file is never touched.
    testHomeDir = mkdtempSync(join(tmpdir(), "oc-mr-router-cmd-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    process.env.HOME = testHomeDir;
    process.env.USERPROFILE = testHomeDir;
    invalidateConfigCache();
    hooks = await ModelRouterPlugin({} as any);
  });

  afterEach(() => {
    if (savedHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = savedHome;
    }
    if (savedUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = savedUserProfile;
    }
    invalidateConfigCache();
    rmSync(testHomeDir, { recursive: true, force: true });
  });

  async function runCommand(command: string, args = ""): Promise<string | undefined> {
    const out = { parts: [] as Array<{ type: string; text: string }> };
    await hooks["command.execute.before"](
      { command, arguments: args },
      out,
    );
    return out.parts[0]?.text;
  }

  it("enforce enforced persists + reload", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, out);
    expect(out.parts[0].text).toContain("enforced");
    expect(out.parts[0].text).toContain("persisted");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("enforced");
  });

  it("enforce off persists", async () => {
    // Prime to enforced first so "off" is a meaningful state transition.
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce enforced" }, { parts: [] as any[] });
    invalidateConfigCache();

    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce off" }, out);
    expect(out.parts[0].text).toContain("off");
    invalidateConfigCache();
    expect(resolveEnforcementMode({ config: loadConfig(), env: {} }).mode).toBe("off");
  });

  it("enforce with no mode shows current + usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce" }, out);
    expect(out.parts[0].text).toContain("Usage:");
    expect(out.parts[0].text).toContain("Current enforcement mode");
  });

  it("invalid mode shows usage", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "enforce loud" }, out);
    expect(out.parts[0].text).toContain("Usage:");
  });

  it("bare /router shows status", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"]({ command: "router", arguments: "" }, out);
    expect(out.parts[0].text).toContain("Enforcement:");
  });

  it("/tiers reports the active bundled tier configuration", async () => {
    const text = await runCommand("tiers");

    expect(text).toContain("Active preset: **anthropic**");
    expect(text).toContain("anthropic/claude-haiku-4-5");
    expect(text).toContain("anthropic/claude-sonnet-4-6");
    expect(text).toContain("anthropic/claude-opus-4-8");
    expect(text).toContain("Steps: 30");
    expect(text).toContain("Steps: 50");
    expect(text).toContain("Steps: 120");
    expect(text).toContain("Default tier: @medium");
    expect(text).toContain(
      "Available presets: anthropic, openai, github-copilot, google, hybrid",
    );
  });

  it("bare /preset lists all bundled presets and marks the active one", async () => {
    const text = await runCommand("preset");

    expect(text).toContain("**anthropic** <- active");
    for (const preset of [
      "anthropic",
      "openai",
      "github-copilot",
      "google",
      "hybrid",
    ]) {
      expect(text).toContain(`**${preset}**`);
    }
  });

  it("/preset resolves case-insensitively, persists state, and requires restart", async () => {
    const text = await runCommand("preset", "OPENAI");

    expect(text).toContain("Preset switched to **openai**");
    expect(text).toContain("@fast -> openai/gpt-5.4-mini-fast");
    expect(text).toContain("@medium -> openai/gpt-5.5-fast");
    expect(text).toContain("@heavy -> openai/gpt-5.5-fast");
    expect(text).toContain(
      "~/.config/opencode/opencode-model-router.state.json",
    );
    expect(text).toContain("Restart OpenCode");
    expect(readState().activePreset).toBe("openai");
  });

  it("unknown /preset reports all available presets", async () => {
    const text = await runCommand("preset", "missing");

    expect(text).toContain('Unknown preset: "missing"');
    expect(text).toContain("anthropic, openai, github-copilot, google, hybrid");
  });

  it("bare /budget lists all modes and marks normal active", async () => {
    const text = await runCommand("budget");

    expect(text).toContain("**normal** <- active");
    for (const mode of ["normal", "budget", "quality", "deep"]) {
      expect(text).toContain(`**${mode}**`);
    }
  });

  it("/budget persists the selected mode and reports its effective rules", async () => {
    const text = await runCommand("budget", "budget");

    expect(text).toContain("Routing mode switched to **budget**");
    expect(text).toContain("Default tier: @fast");
    expect(text).toContain("Active rules:");
    expect(text).toContain("default→@fast unless edits/complex-reasoning needed");
    expect(text).toContain("next message");
    expect(readState().activeMode).toBe("budget");
  });

  it("unknown /budget reports all available modes", async () => {
    const text = await runCommand("budget", "missing");

    expect(text).toContain('Unknown mode: "missing"');
    expect(text).toContain("normal, budget, quality, deep");
  });

  it("/bypass disables and restores system prompt injection", async () => {
    const systemHook = hooks["experimental.chat.system.transform"];
    const input = {
      sessionID: "orchestrator",
      model: { providerID: "openai", modelID: "gpt-5" },
    };

    expect(await runCommand("bypass", "on")).toContain("Bypass: ON");
    const bypassed = { system: [] as string[] };
    await systemHook(input, bypassed);
    expect(bypassed.system).toEqual([]);

    expect(await runCommand("bypass", "off")).toContain("Bypass: OFF");
    const active = { system: [] as string[] };
    await systemHook(input, active);
    expect(active.system).toHaveLength(1);
    expect(active.system[0]).toContain("## Model Delegation Protocol");
  });

  it("unknown commands leave output unchanged", async () => {
    const out = { parts: [] as any[] };
    await hooks["command.execute.before"](
      { command: "unknown", arguments: "" },
      out,
    );
    expect(out.parts).toEqual([]);
  });

  it("updates prompt routing immediately but captures agent models until restart", async () => {
    await runCommand("preset", "openai");

    const transformed = { system: [] as string[] };
    await hooks["experimental.chat.system.transform"](
      {
        sessionID: "orchestrator",
        model: { providerID: "openai", modelID: "gpt-5" },
      },
      transformed,
    );
    expect(transformed.system[0]).toContain("Preset: openai");

    const capturedConfig: any = {};
    await hooks.config(capturedConfig);
    expect(capturedConfig.agent.fast.model).toBe(
      "anthropic/claude-haiku-4-5",
    );

    invalidateConfigCache();
    const restartedHooks: any = await ModelRouterPlugin({} as any);
    const restartedConfig: any = {};
    await restartedHooks.config(restartedConfig);
    expect(restartedConfig.agent.fast.model).toBe(
      "openai/gpt-5.4-mini-fast",
    );
  });
});
