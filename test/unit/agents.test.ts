import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/router/config";
import {
  buildAgentSpecs,
  CLAUDE_SUBAGENT_PREFIX,
  IMPLEMENTATION_RESEARCH_BLOCK,
  REVIEW_HANDBACK_BLOCK,
  SHARED_SUBAGENT_CONTRACT,
} from "../../src/router/agents";
import { CLAUDE_ANTI_NARRATION } from "../../src/router/protocol";

function model(name: string, costRatio = 1) {
  return { model: `test/${name}`, costRatio, description: `${name} tier`, whenToUse: [] as string[] };
}

function baseConfig(extra: Record<string, unknown> = {}) {
  return validateConfig({
    schemaVersion: 2,
    activePreset: "test",
    models: {
      fast: model("fast", 1),
      medium: model("medium", 5),
      heavy: model("heavy", 20),
    },
    ...extra,
  });
}

describe("buildAgentSpecs pure generation", () => {
  it("generates exactly eleven canonical agents plus three aliases for the default matrix", () => {
    const specs = buildAgentSpecs(baseConfig());

    expect(specs.canonical).toHaveLength(11);
    expect(specs.aliases).toHaveLength(3);

    const canonicalNames = specs.canonical.map((entry) => entry.agentName);
    expect(canonicalNames).toEqual([
      "explore-fast",
      "explore-medium",
      "research-fast",
      "research-medium",
      "implementation-fast",
      "implementation-medium",
      "implementation-heavy",
      "architecture-medium",
      "architecture-heavy",
      "review-medium",
      "review-heavy",
    ]);

    const aliasNames = specs.aliases.map((entry) => entry.agentName);
    expect(aliasNames).toEqual(["fast", "medium", "heavy"]);

    expect(Object.keys(specs.byName).sort()).toEqual([
      "architecture-heavy",
      "architecture-medium",
      "explore-fast",
      "explore-medium",
      "fast",
      "heavy",
      "implementation-fast",
      "implementation-heavy",
      "implementation-medium",
      "medium",
      "research-fast",
      "research-medium",
      "review-heavy",
      "review-medium",
    ]);
  });

  it("only generates combinations inside each role allowedTiers", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        roles: {
          explore: { allowedTiers: ["fast"] },
          architecture: { allowedTiers: ["heavy"] },
        },
      }),
    );

    const canonicalNames = specs.canonical.map((entry) => entry.agentName);
    expect(canonicalNames).not.toContain("explore-medium");
    expect(canonicalNames).not.toContain("architecture-medium");
    expect(canonicalNames).toContain("explore-fast");
    expect(canonicalNames).toContain("architecture-heavy");
    expect(canonicalNames).toHaveLength(9);
  });

  it("does not create a full Cartesian product outside allowedTiers", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        roles: {
          explore: { allowedTiers: ["fast"] },
          research: { allowedTiers: ["fast"] },
          implementation: { allowedTiers: ["fast"] },
          architecture: { allowedTiers: ["fast"] },
          review: { allowedTiers: ["fast"] },
        },
      }),
    );
    expect(specs.canonical).toHaveLength(5);
    expect(specs.canonical.every((entry) => entry.agentName.endsWith("-fast"))).toBe(true);
  });

  it("resolves model through role override, then active preset, then top-level tier", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        presets: { test: { medium: { model: "preset/medium", variant: "preset-variant" } } },
        roles: {
          implementation: {
            modelOverrides: {
              medium: { model: "override/medium", variant: "override-variant" },
            },
          },
        },
      }),
    );

    const agent = specs.byName["implementation-medium"];
    expect(agent?.model).toBe("override/medium");
    expect(agent?.variant).toBe("override-variant");

    const exploreMedium = specs.byName["explore-medium"];
    expect(exploreMedium?.model).toBe("preset/medium");
    expect(exploreMedium?.variant).toBe("preset-variant");

    const exploreFast = specs.byName["explore-fast"];
    expect(exploreFast?.model).toBe("test/fast");
  });

  it("uses steps and never emits maxSteps on canonical or alias specs", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        presets: { test: { medium: { steps: 12 } } },
      }),
    );
    for (const spec of Object.values(specs.byName)) {
      expect(spec).toHaveProperty("mode", "subagent");
      expect(spec).not.toHaveProperty("maxSteps");
      if (spec.steps !== undefined) {
        expect(Number.isInteger(spec.steps)).toBe(true);
      }
    }
    expect(specs.byName["implementation-medium"]?.steps).toBe(12);
  });

  it("emits permission.task deny on every canonical and alias agent", () => {
    const specs = buildAgentSpecs(baseConfig());
    for (const spec of Object.values(specs.byName)) {
      expect(spec.permission).toEqual({ task: "deny" });
    }
  });

  it("marks legacy aliases hidden and canonical agents visible", () => {
    const specs = buildAgentSpecs(baseConfig());
    for (const entry of specs.canonical) {
      expect(entry.spec).not.toHaveProperty("hidden");
    }
    for (const entry of specs.aliases) {
      expect(entry.spec).toMatchObject({ hidden: true });
    }
  });

  it("registers hidden aliases that resolve to their canonical target spec", () => {
    const specs = buildAgentSpecs(baseConfig());
    expect(specs.aliases[0]?.identity).toEqual({
      role: "explore",
      tier: "fast",
      agentName: "explore-fast",
    });
    expect(specs.aliases[1]?.identity).toEqual({
      role: "implementation",
      tier: "medium",
      agentName: "implementation-medium",
    });
    expect(specs.aliases[2]?.identity).toEqual({
      role: "architecture",
      tier: "heavy",
      agentName: "architecture-heavy",
    });
  });

  it("omits legacy aliases when compatibility disables them", () => {
    const specs = buildAgentSpecs(
      baseConfig({ compatibility: { legacyAliases: false } }),
    );
    expect(specs.aliases).toHaveLength(0);
    expect(specs.canonical).toHaveLength(11);
    expect(specs.byName).not.toHaveProperty("fast");
    expect(specs.byName).not.toHaveProperty("medium");
    expect(specs.byName).not.toHaveProperty("heavy");
  });

  it("still registers explicit aliases when synthesis is disabled", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        compatibility: {
          legacyAliases: false,
          aliases: {
            "quick-review": { role: "review", tier: "medium" },
          },
        },
      }),
    );
    expect(specs.aliases).toHaveLength(1);
    expect(specs.aliases[0]?.agentName).toBe("quick-review");
    expect(specs.byName["quick-review"]).toBeDefined();
  });

  it("allows an explicit alias to replace a synthesized alias", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        compatibility: {
          aliases: {
            fast: { role: "implementation", tier: "fast" },
          },
        },
      }),
    );
    expect(specs.aliases[0]?.identity).toEqual({
      role: "implementation",
      tier: "fast",
      agentName: "implementation-fast",
    });
  });

  it("composes canonical prompts in the shared, role, tier, return order", () => {
    const specs = buildAgentSpecs(baseConfig());
    const agent = specs.byName["explore-fast"];
    const prompt = agent?.prompt ?? "";

    const sharedIndex = prompt.indexOf(SHARED_SUBAGENT_CONTRACT);
    const roleIndex = prompt.indexOf("Explore the local codebase");
    const tierIndex = prompt.indexOf("Tier: fast");
    const returnIndex = prompt.indexOf("Return findings with file and line references.");

    expect(sharedIndex).toBeGreaterThanOrEqual(0);
    expect(roleIndex).toBeGreaterThan(sharedIndex);
    expect(tierIndex).toBeGreaterThan(roleIndex);
    expect(returnIndex).toBeGreaterThan(tierIndex);
  });

  it("injects the NEEDS_RESEARCH block only for implementation agents", () => {
    const specs = buildAgentSpecs(baseConfig());
    for (const entry of specs.canonical) {
      if (entry.agentName.startsWith("implementation-")) {
        expect(entry.spec.prompt).toContain(IMPLEMENTATION_RESEARCH_BLOCK);
      } else {
        expect(entry.spec.prompt).not.toContain(IMPLEMENTATION_RESEARCH_BLOCK);
      }
    }
  });

  it("injects the review hand-back instruction only for review agents", () => {
    const specs = buildAgentSpecs(baseConfig());
    for (const entry of specs.canonical) {
      if (entry.agentName.startsWith("review-")) {
        expect(entry.spec.prompt).toContain(REVIEW_HANDBACK_BLOCK);
      } else {
        expect(entry.spec.prompt).not.toContain(REVIEW_HANDBACK_BLOCK);
      }
    }
  });

  it("prepends a role-neutral Claude prefix on canonical Claude agents", () => {
    const config = baseConfig({
      presets: { test: { fast: { model: "anthropic/claude-haiku-4-5" } } },
    });
    const specs = buildAgentSpecs(config);
    const prompt = specs.byName["explore-fast"]?.prompt ?? "";
    expect(prompt.startsWith(CLAUDE_SUBAGENT_PREFIX)).toBe(true);
    expect(prompt).toContain(CLAUDE_ANTI_NARRATION);
  });

  it("does not prepend the canonical Claude prefix on legacy aliases", () => {
    const config = baseConfig({
      presets: { test: { fast: { model: "anthropic/claude-haiku-4-5" } } },
      tierPrompts: { fast: "legacy fast prompt" },
    });
    const specs = buildAgentSpecs(config);
    const aliasPrompt = specs.byName["fast"]?.prompt ?? "";
    expect(aliasPrompt).toContain("legacy fast prompt");
    expect(aliasPrompt).not.toContain(CLAUDE_SUBAGENT_PREFIX);
  });

  it("translates thinking and reasoning into provider options and omits empty options", () => {
    const withOptions = buildAgentSpecs(
      baseConfig({
        presets: {
          test: {
            fast: {
              thinking: { budgetTokens: 2048 },
              reasoning: { effort: "high", summary: "auto" },
            },
          },
        },
      }),
    );
    expect(withOptions.byName["explore-fast"]?.options).toEqual({
      budget_tokens: 2048,
      reasoning_effort: "high",
      reasoning_summary: "auto",
    });

    const withoutOptions = buildAgentSpecs(
      baseConfig({
        presets: { test: { fast: { thinking: {}, reasoning: {} } } },
      }),
    );
    expect(withoutOptions.byName["explore-fast"]).not.toHaveProperty("options");
  });

  it("preserves resolved color when configured", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        presets: { test: { fast: { color: "#ff0000" } } },
      }),
    );
    expect(specs.byName["explore-fast"]?.color).toBe("#ff0000");
  });

  it("uses the role description plus tier suffix for canonical descriptions", () => {
    const specs = buildAgentSpecs(baseConfig());
    expect(specs.byName["explore-fast"]?.description).toBe(
      "Inspect the local codebase without modifying it (fast tier)",
    );
    expect(specs.byName["implementation-medium"]?.description).toBe(
      "Modify code and run implementation verification (medium (implementation tier))",
    );
  });

  it("prefers an explicit role model override description when provided", () => {
    const specs = buildAgentSpecs(
      baseConfig({
        roles: {
          implementation: {
            modelOverrides: {
              medium: { description: "custom implementation medium" },
            },
          },
        },
      }),
    );
    expect(specs.byName["implementation-medium"]?.description).toBe("custom implementation medium");
    expect(specs.byName["explore-medium"]?.description).toBe(
      "Inspect the local codebase without modifying it (medium tier)",
    );
  });

  it("rejects duplicate canonical agent names produced by hyphen collisions", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 2,
        activePreset: "test",
        models: {
          "b-c": model("bc", 1),
          c: model("c", 2),
        },
        roles: {
          a: {
            description: "a",
            prompt: "a",
            returnProtocol: "a",
            defaultTier: "b-c",
            allowedTiers: ["b-c"],
            taskPatterns: [],
          },
          "a-b": {
            description: "b",
            prompt: "b",
            returnProtocol: "b",
            defaultTier: "c",
            allowedTiers: ["c"],
            taskPatterns: [],
          },
        },
      }),
    ).toThrow(/collides/);
  });

  it("rejects alias names that collide case-insensitively with canonical agents", () => {
    expect(() =>
      validateConfig({
        schemaVersion: 2,
        activePreset: "test",
        models: { fast: model("fast", 1) },
        compatibility: {
          legacyAliases: false,
          aliases: { "EXPLORE-FAST": { role: "explore", tier: "fast" } },
        },
        roles: {
          explore: {
            allowedTiers: ["fast"],
            defaultTier: "fast",
          },
        },
      }),
    ).toThrow(/must not collide case-insensitively/);
  });

  it("does not mutate the normalized configuration input", () => {
    const config = baseConfig();
    const before = JSON.stringify(config);
    buildAgentSpecs(config);
    expect(JSON.stringify(config)).toBe(before);
  });

  it("supports custom roles and custom tiers in the canonical matrix", () => {
    const specs = buildAgentSpecs(
      validateConfig({
        schemaVersion: 2,
        activePreset: "test",
        models: {
          economy: model("economy", 1),
          premium: model("premium", 10),
        },
        roles: {
          documentation: {
            description: "Write documentation",
            prompt: "Document the change.",
            returnProtocol: "Return the updated document.",
            defaultTier: "economy",
            allowedTiers: ["economy", "premium"],
            taskPatterns: ["write-docs"],
          },
        },
        compatibility: { legacyAliases: false },
      }),
    );
    // 5 default roles (adapted to custom tiers) + 1 custom role
    expect(specs.canonical.length).toBeGreaterThanOrEqual(2);
    expect(specs.canonical.some((entry) => entry.agentName === "documentation-economy")).toBe(true);
    expect(specs.canonical.some((entry) => entry.agentName === "documentation-premium")).toBe(true);
  });
});
