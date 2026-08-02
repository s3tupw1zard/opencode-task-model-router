import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { PluginInput } from "@opencode-ai/plugin";
import ModelRouterPlugin from "../../src/index";
import {
  invalidateConfigCache,
  loadConfig,
  projectConfigPath,
  writeState,
} from "../../src/router/config";
import {
  CLAUDE_ANTI_NARRATION,
  CLAUDE_TIER_PREFIX,
  isClaudeModel,
} from "../../src/router/protocol";

type GeneratedAgent = Record<string, unknown>;
type MutableOpenCodeConfig = {
  agent?: Record<string, GeneratedAgent>;
  command?: Record<string, Record<string, unknown>>;
};

const PRESETS = {
  anthropic: {
    fast: ["anthropic/claude-haiku-4-5", undefined, 30],
    medium: ["anthropic/claude-sonnet-4-6", "max", 50],
    heavy: ["anthropic/claude-opus-4-8", "max", 120],
  },
  openai: {
    fast: ["openai/gpt-5.4-mini-fast", undefined, 30],
    medium: ["openai/gpt-5.5-fast", "high", 50],
    heavy: ["openai/gpt-5.5-fast", "xhigh", 120],
  },
  "github-copilot": {
    fast: ["github-copilot/claude-haiku-4-5", undefined, 30],
    medium: ["github-copilot/claude-sonnet-4-6", undefined, 50],
    heavy: ["github-copilot/claude-opus-4-6", "thinking", 120],
  },
  google: {
    fast: ["google/gemini-2.5-flash", undefined, 30],
    medium: ["google/gemini-2.5-pro", undefined, 50],
    heavy: ["google/gemini-3-pro-preview", undefined, 120],
  },
  hybrid: {
    fast: ["anthropic/claude-haiku-4-5", undefined, 30],
    medium: ["openai/gpt-5.5-fast", "high", 50],
    heavy: ["anthropic/claude-opus-4-8", "max", 120],
  },
} as const;

const ROUTER_ENV_KEYS = [
  "TASK_MODEL_ROUTER_ENFORCE",
  "TASK_MODEL_ROUTER_VERIFIED_DELEGATE",
  "TASK_MODEL_ROUTER_TRAJECTORY_DEBUG",
  "MODEL_ROUTER_ENFORCE",
  "MODEL_ROUTER_VERIFIED_DELEGATE",
  "MODEL_ROUTER_TRAJECTORY_DEBUG",
] as const;

function fakePluginInput(directory: string, worktree = directory): PluginInput {
  return {
    directory,
    worktree,
    project: {} as PluginInput["project"],
    serverUrl: new URL("http://localhost"),
    $: (() => {}) as unknown as PluginInput["$"],
    client: {
      session: {
        create: async () => ({ data: { id: "unused" } }),
        prompt: async () => ({ data: { parts: [] } }),
      },
    } as unknown as PluginInput["client"],
  } as PluginInput;
}

describe.sequential("config hook characterization", () => {
  let home: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  let savedRouterEnv: Record<string, string | undefined>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "oc-mr-config-hook-"));
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    savedRouterEnv = Object.fromEntries(
      ROUTER_ENV_KEYS.map((key) => [key, process.env[key]]),
    );
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    for (const key of ROUTER_ENV_KEYS) delete process.env[key];
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    for (const key of ROUTER_ENV_KEYS) {
      const value = savedRouterEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true });
  });

  async function runConfigHook(
    target: MutableOpenCodeConfig = {},
  ): Promise<MutableOpenCodeConfig> {
    const hooks = await ModelRouterPlugin(fakePluginInput(home));
    expect(hooks.config).toBeTypeOf("function");
    await hooks.config!(target as Parameters<NonNullable<typeof hooks.config>>[0]);
    return target;
  }

  function writeProjectConfig(projectRoot: string, value: unknown): void {
    const path = projectConfigPath(projectRoot);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
  }

  it("registers the current agents and commands without removing unrelated entries", async () => {
    const target = await runConfigHook({
      agent: { custom: { description: "keep me" } },
      command: { custom: { description: "keep me", template: "custom" } },
    });

    expect(Object.keys(target.agent ?? {}).sort()).toEqual([
      "custom",
      "fast",
      "heavy",
      "medium",
    ]);
    expect(target.agent?.custom).toEqual({ description: "keep me" });

    expect(Object.keys(target.command ?? {}).sort()).toEqual([
      "annotate-plan",
      "budget",
      "bypass",
      "custom",
      "preset",
      "router",
      "tiers",
    ]);
    expect(target.command?.custom).toEqual({
      description: "keep me",
      template: "custom",
    });
    expect(target.command?.tiers?.template).toBe("");
    expect(target.command?.preset?.template).toBe("$ARGUMENTS");
    expect(target.command?.budget?.template).toBe("$ARGUMENTS");
    expect(target.command?.bypass?.template).toBe("$ARGUMENTS");
    expect(target.command?.router?.template).toBe("$ARGUMENTS");

    const annotation = String(target.command?.["annotate-plan"]?.template);
    expect(annotation).toContain("[tier:fast]");
    expect(annotation).toContain("[tier:medium]");
    expect(annotation).toContain("[tier:heavy]");
    expect(annotation).toContain("[acceptance]");
    expect(annotation).toContain("check:");
    expect(annotation).toContain("criteria:");
    expect(annotation).toContain("deliverable:");
  });

  for (const [presetName, expectedTiers] of Object.entries(PRESETS)) {
    it(`registers the bundled ${presetName} agent matrix`, async () => {
      writeState({ activePreset: presetName });
      invalidateConfigCache();
      const target = await runConfigHook();
      const cfg = loadConfig({ projectRoot: home });

      expect(Object.keys(target.agent ?? {})).toEqual(["fast", "medium", "heavy"]);

      for (const [tierName, expected] of Object.entries(expectedTiers)) {
        const [model, variant, maxSteps] = expected;
        const agent = target.agent?.[tierName];
        const tier = cfg.presets[presetName]?.[tierName];
        expect(agent).toBeDefined();
        expect(tier).toBeDefined();
        expect(agent).toMatchObject({
          model,
          mode: "subagent",
          description: tier?.description,
          maxSteps,
        });
        expect(agent).toHaveProperty("maxSteps");
        expect(agent).not.toHaveProperty("steps");
        expect(agent).not.toHaveProperty("permission");
        expect(agent).not.toHaveProperty("costRatio");
        expect(agent).not.toHaveProperty("whenToUse");
        expect(agent).not.toHaveProperty("options");
        if (variant === undefined) expect(agent).not.toHaveProperty("variant");
        else expect(agent?.variant).toBe(variant);

        const tierPrompt = cfg.tierPrompts?.[tierName];
        expect(tierPrompt).toBeTypeOf("string");
        if (isClaudeModel(model)) {
          const prefix = `${CLAUDE_TIER_PREFIX[tierName]}\n\n${CLAUDE_ANTI_NARRATION}`;
          expect(agent?.prompt).toBe(`${prefix}\n\n---\n\n${tierPrompt}`);
        } else {
          expect(agent?.prompt).toBe(tierPrompt);
        }
      }
    });
  }

  it("maps optional thinking and reasoning settings into provider options", async () => {
    const cfg = loadConfig({ projectRoot: home });
    cfg.presets.anthropic!.medium!.thinking = { budgetTokens: 4096 };
    cfg.presets.anthropic!.medium!.reasoning = {
      effort: "high",
      summary: "always",
    };

    const target = await runConfigHook();

    expect(target.agent?.medium?.options).toEqual({
      budget_tokens: 4096,
      reasoning_effort: "high",
      reasoning_summary: "always",
    });
  });

  it("omits empty provider options and keeps the Claude prefix on a tier prompt override", async () => {
    const cfg = loadConfig({ projectRoot: home });
    cfg.presets.anthropic!.fast!.thinking = {};
    cfg.presets.anthropic!.fast!.reasoning = {};
    cfg.presets.anthropic!.fast!.prompt = "CUSTOM FAST PROMPT";

    const target = await runConfigHook();
    const agent = target.agent?.fast;
    const prefix = `${CLAUDE_TIER_PREFIX.fast}\n\n${CLAUDE_ANTI_NARRATION}`;

    expect(agent).not.toHaveProperty("options");
    expect(agent?.prompt).toBe(`${prefix}\n\n---\n\nCUSTOM FAST PROMPT`);
    expect(agent?.prompt).not.toContain("ROLE: You are @fast");
  });

  it("loads project configuration from worktree instead of a nested directory", async () => {
    const worktree = join(home, "repo");
    const directory = join(worktree, "packages", "app");
    mkdirSync(directory, { recursive: true });
    writeProjectConfig(worktree, {
      presets: { anthropic: { fast: { model: "test/worktree-model" } } },
    });
    writeProjectConfig(directory, {
      presets: { anthropic: { fast: { model: "test/directory-model" } } },
    });

    const hooks = await ModelRouterPlugin(fakePluginInput(directory, worktree));
    const target: MutableOpenCodeConfig = {};
    await hooks.config!(target as Parameters<NonNullable<typeof hooks.config>>[0]);

    expect(target.agent?.fast?.model).toBe("test/worktree-model");
  });

  it("ignores a filesystem-root worktree sentinel and uses directory", async () => {
    const directory = join(home, "non-git-project");
    mkdirSync(directory, { recursive: true });
    writeProjectConfig(directory, {
      presets: { anthropic: { fast: { model: "test/directory-fallback" } } },
    });

    const hooks = await ModelRouterPlugin(fakePluginInput(directory, "/"));
    const target: MutableOpenCodeConfig = {};
    await hooks.config!(target as Parameters<NonNullable<typeof hooks.config>>[0]);

    expect(target.agent?.fast?.model).toBe("test/directory-fallback");
  });

  it("does not enable the delegate tool through the old environment variable", async () => {
    process.env.MODEL_ROUTER_VERIFIED_DELEGATE = "1";

    const hooks = await ModelRouterPlugin(fakePluginInput(home));

    expect(hooks.tool?.delegate).toBeUndefined();
  });
});
