import { describe, expect, it } from "vitest";
import { validateConfig, type NormalizedRouterConfig } from "../../src/router/config";
import {
  classifyTaskRole,
  resolveAgentIdentity,
  RoutingError,
  selectModelTier,
} from "../../src/router/routing";

function model(name: string, costRatio: number) {
  return { model: `test/${name}`, costRatio };
}

function routingConfig(extra: Record<string, unknown> = {}): NormalizedRouterConfig {
  return validateConfig({
    schemaVersion: 2,
    activePreset: "test",
    models: {
      fast: model("fast", 1),
      medium: model("medium", 5),
      heavy: model("heavy", 20),
    },
    taskPatterns: {
      fast: ["cheap-signal"],
      medium: ["standard-signal"],
      heavy: ["complex-signal"],
    },
    modes: {
      normal: { defaultTier: "medium", description: "normal" },
      budget: { defaultTier: "fast", description: "budget" },
      quality: { defaultTier: "medium", description: "quality" },
      deep: { defaultTier: "heavy", description: "deep" },
    },
    enforcement: { escalate: { ladder: ["fast", "medium", "heavy"] } },
    ...extra,
  });
}

function expectRoutingError(run: () => unknown, code: RoutingError["code"]): void {
  try {
    run();
    throw new Error("Expected routing to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RoutingError);
    expect((error as RoutingError).code).toBe(code);
  }
}

describe("independent role and tier routing", () => {
  it.each([
    ["Locate the request handler", "explore"],
    ["Research the official documentation", "research"],
    ["Implement the request handler", "implementation"],
    ["Analyze the architecture tradeoff", "architecture"],
    ["Review these changes for regression risk", "review"],
  ])("classifies %s as %s", (task, expected) => {
    expect(classifyTaskRole(task, routingConfig())).toBe(expected);
  });

  it("uses configured role patterns instead of hardcoded keywords", () => {
    const config = routingConfig({
      roles: { review: { taskPatterns: ["critic-marker"] } },
    });

    expect(classifyTaskRole("Run the critic-marker pass", config)).toBe("review");
    expect(classifyTaskRole("review this otherwise unmatched request", config)).toBe(
      "implementation",
    );
  });

  it("uses the configured default role for empty and unmatched tasks", () => {
    const config = routingConfig({ defaultRole: "research" });
    expect(classifyTaskRole("", config)).toBe("research");
    expect(classifyTaskRole("completely unmatched request", config)).toBe("research");
  });

  it("prefers the longest role pattern and then the greatest match count", () => {
    const longest = routingConfig({
      roles: {
        explore: { taskPatterns: ["shared", "highly specific marker"] },
        review: { taskPatterns: ["shared", "specific marker"] },
      },
    });
    expect(classifyTaskRole("shared highly specific marker", longest)).toBe("explore");

    const count = routingConfig({
      roles: {
        explore: { taskPatterns: ["shared-long", "extra"] },
        review: { taskPatterns: ["shared-long"] },
      },
    });
    expect(classifyTaskRole("shared-long and extra", count)).toBe("explore");
  });

  it("rejects an exact role-classification tie", () => {
    const config = routingConfig({
      roles: {
        explore: { taskPatterns: ["shared"] },
        review: { taskPatterns: ["shared"] },
      },
    });
    expectRoutingError(() => classifyTaskRole("shared", config), "ambiguous-role");
  });

  it("supports strict role directives with case and whitespace normalization", () => {
    const config = routingConfig();
    expect(classifyTaskRole("[ ROLE : Review ] implement this", config)).toBe("review");
    expect(classifyTaskRole("[role:review] [role:REVIEW] implement this", config)).toBe(
      "review",
    );
  });

  it("ignores role directives inside fenced and inline code", () => {
    const config = routingConfig();
    expect(classifyTaskRole("`[role:review]` implement this", config)).toBe("implementation");
    expect(classifyTaskRole("``[role:review]`` implement this", config)).toBe("implementation");
    expect(
      classifyTaskRole("```text\n[role:review]\n```\nimplement this", config),
    ).toBe("implementation");
    expect(
      classifyTaskRole("````text\n```\n[role:review]\n````\nimplement this", config),
    ).toBe("implementation");
    expect(
      classifyTaskRole("~~~text\n[role:review]\n~~~\nimplement this", config),
    ).toBe("implementation");
    expect(
      classifyTaskRole("`example\n[role:review]\n`\nimplement this", config),
    ).toBe("implementation");
    expect(
      classifyTaskRole("> ```text\n> [role:review]\n> ```\nimplement this", config),
    ).toBe("implementation");
    expect(classifyTaskRole("    [role:review]\nimplement this", config)).toBe(
      "implementation",
    );
  });

  it("rejects unknown and conflicting role directives", () => {
    const config = routingConfig();
    expectRoutingError(() => classifyTaskRole("[role:missing] inspect", config), "unknown-role");
    expectRoutingError(
      () => classifyTaskRole("[role:review] [role:explore] inspect", config),
      "conflicting-role-directives",
    );
  });

  it.each([
    ["cheap-signal work", "fast"],
    ["standard-signal work", "medium"],
    ["complex-signal work", "heavy"],
  ])("selects %s as %s", (task, expected) => {
    expect(selectModelTier(task, "implementation", routingConfig())).toBe(expected);
  });

  it("selects the strongest matching tier signal according to the configured ladder", () => {
    const config = routingConfig();
    expect(selectModelTier("cheap-signal and complex-signal", "implementation", config)).toBe(
      "heavy",
    );
  });

  it("falls back to each role default when no mode or tier signal applies", () => {
    const config = routingConfig();
    expect(selectModelTier("unmatched", "explore", config)).toBe("fast");
    expect(selectModelTier("unmatched", "research", config)).toBe("fast");
    expect(selectModelTier("unmatched", "implementation", config)).toBe("medium");
    expect(selectModelTier("unmatched", "architecture", config)).toBe("medium");
    expect(selectModelTier("unmatched", "review", config)).toBe("medium");
  });

  it("lets explicit tier directives override automatic signals and modes", () => {
    const config = routingConfig({ activeMode: "deep" });
    expect(selectModelTier("[tier:fast] complex-signal work", "implementation", config)).toBe(
      "fast",
    );
    expect(selectModelTier("[ TIER : Heavy ] cheap-signal work", "implementation", config)).toBe(
      "heavy",
    );
    expect(
      selectModelTier("[tier:fast] [tier:FAST] complex-signal work", "implementation", config),
    ).toBe("fast");
  });

  it("ignores tier directives inside code", () => {
    const config = routingConfig();
    expect(selectModelTier("`[tier:heavy]` cheap-signal", "implementation", config)).toBe(
      "fast",
    );
  });

  it("rejects unknown and conflicting tier directives", () => {
    const config = routingConfig();
    expectRoutingError(
      () => selectModelTier("[tier:missing] work", "implementation", config),
      "unknown-tier",
    );
    expectRoutingError(
      () => selectModelTier("[tier:fast] [tier:heavy] work", "implementation", config),
      "conflicting-tier-directives",
    );
  });

  it("rejects unknown roles and explicit unsupported combinations", () => {
    const config = routingConfig();
    expectRoutingError(() => selectModelTier("work", "missing", config), "unknown-role");
    expectRoutingError(
      () => selectModelTier("[tier:heavy] inspect", "explore", config),
      "unsupported-role-tier",
    );
    expectRoutingError(
      () => selectModelTier("[tier:fast] review", "review", config),
      "unsupported-role-tier",
    );
  });

  it("adjusts automatic unsupported tiers upward first and downward only as fallback", () => {
    const config = routingConfig();
    expect(selectModelTier("cheap-signal", "architecture", config)).toBe("medium");
    expect(selectModelTier("complex-signal", "explore", config)).toBe("medium");

    const sparse = routingConfig({
      roles: {
        implementation: {
          defaultTier: "fast",
          allowedTiers: ["fast", "heavy"],
        },
      },
    });
    expect(selectModelTier("standard-signal", "implementation", sparse)).toBe("heavy");
  });

  it.each([
    ["budget", "implementation", "fast"],
    ["quality", "implementation", "medium"],
    ["deep", "implementation", "heavy"],
    ["budget", "architecture", "medium"],
    ["deep", "explore", "medium"],
  ])("applies %s mode to %s without changing role", (mode, role, tier) => {
    const identity = resolveAgentIdentity(
      `[role:${role}] unmatched`,
      routingConfig({ activeMode: mode }),
    );
    expect(identity).toEqual({ role, tier, agentName: `${role}-${tier}` });
  });

  it("resolves role and tier independently", () => {
    const config = routingConfig();
    expect(resolveAgentIdentity("[tier:fast] implement this", config)).toEqual({
      role: "implementation",
      tier: "fast",
      agentName: "implementation-fast",
    });
    expect(resolveAgentIdentity("[role:review] complex-signal changes", config)).toEqual({
      role: "review",
      tier: "heavy",
      agentName: "review-heavy",
    });
    expect(
      resolveAgentIdentity("[role:research] [tier:medium] inspect documentation", config),
    ).toEqual({
      role: "research",
      tier: "medium",
      agentName: "research-medium",
    });
  });

  it("supports custom roles, tiers, and cost-based ordering", () => {
    const config = validateConfig({
      schemaVersion: 2,
      activePreset: "test",
      defaultRole: "documentation",
      models: {
        economy: model("economy", 1),
        standard: model("standard", 4),
        expert: model("expert", 12),
      },
      taskPatterns: { economy: ["quick"], standard: ["normal"], expert: ["deep"] },
      roles: {
        documentation: {
          description: "Write and maintain documentation",
          prompt: "Document the requested behavior.",
          returnProtocol: "Return the changed documentation.",
          defaultTier: "economy",
          allowedTiers: ["economy", "expert"],
          taskPatterns: ["docs"],
        },
      },
    });

    expect(resolveAgentIdentity("docs normal", config)).toEqual({
      role: "documentation",
      tier: "expert",
      agentName: "documentation-expert",
    });
  });

  it("uses the legacy default ladder before standard-tier cost ratios", () => {
    const config = routingConfig({
      models: {
        fast: model("fast", 20),
        medium: model("medium", 1),
        heavy: model("heavy", 5),
      },
      enforcement: {},
    });
    expect(selectModelTier("cheap-signal and complex-signal", "implementation", config)).toBe(
      "heavy",
    );
  });

  it("reports when an explicit ladder cannot order an automatic adjustment", () => {
    const config = validateConfig({
      schemaVersion: 2,
      activePreset: "test",
      defaultRole: "documentation",
      models: {
        economy: model("economy", 1),
        standard: model("standard", 4),
        expert: model("expert", 12),
      },
      taskPatterns: { standard: ["normal"] },
      roles: {
        documentation: {
          description: "Write and maintain documentation",
          prompt: "Document the requested behavior.",
          returnProtocol: "Return the changed documentation.",
          defaultTier: "expert",
          allowedTiers: ["expert"],
          taskPatterns: ["docs"],
        },
      },
      enforcement: { escalate: { ladder: ["economy", "standard"] } },
    });

    expectRoutingError(
      () => resolveAgentIdentity("docs normal", config),
      "missing-tier-order",
    );
  });

  it("does not mutate normalized routing configuration", () => {
    const config = routingConfig({ activeMode: "deep" });
    const before = JSON.stringify(config);
    resolveAgentIdentity("Review cheap-signal changes", config);
    expect(JSON.stringify(config)).toBe(before);
  });
});
