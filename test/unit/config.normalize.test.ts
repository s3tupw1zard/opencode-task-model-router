import { describe, expect, it } from "vitest";
import { validateConfig } from "../../src/router/config";

function model(model: string, extra: Record<string, unknown> = {}) {
  return { model, costRatio: 1, ...extra };
}

function v2(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    activePreset: "test",
    models: {
      fast: model("test/fast", { costRatio: 1 }),
      medium: model("test/medium", { costRatio: 5 }),
      heavy: model("test/heavy", { costRatio: 20 }),
    },
    ...extra,
  };
}

function v2WithFast(extra: Record<string, unknown>) {
  const config = v2();
  return {
    ...config,
    models: {
      ...config.models,
      fast: model("test/fast", extra),
    },
  };
}

function v1(extra: Record<string, unknown> = {}) {
  return {
    activePreset: "first",
    presets: {
      first: {
        fast: {
          model: "test/first-fast",
          description: "first fast",
          whenToUse: ["lookup"],
        },
        medium: {
          model: "test/first-medium",
          variant: "max",
          description: "first medium",
          whenToUse: ["implement"],
        },
        heavy: {
          model: "test/first-heavy",
          description: "first heavy",
          whenToUse: ["design"],
        },
      },
      second: {
        fast: {
          model: "test/second-fast",
          description: "second fast",
          whenToUse: ["lookup"],
        },
        medium: {
          model: "test/second-medium",
          description: "second medium",
          whenToUse: ["implement"],
        },
        heavy: {
          model: "test/second-heavy",
          variant: "thinking",
          description: "second heavy",
          whenToUse: ["design"],
        },
      },
    },
    rules: ["legacy rule"],
    defaultTier: "medium",
    tierCaps: { fast: 8, medium: 5, heavy: 3 },
    tierPrompts: { fast: "legacy explorer" },
    taskPatterns: { fast: ["lookup"], medium: ["implement"], heavy: ["design"] },
    ...extra,
  };
}

describe("canonical configuration normalization", () => {
  it("normalizes v1 without changing preset model fields", () => {
    const config = validateConfig(v1());

    expect(config.schemaVersion).toBe(2);
    expect(config.models.fast.model).toBe("test/first-fast");
    expect(config.presets.first.medium.variant).toBe("max");
    expect(config.presets.second.medium).not.toHaveProperty("variant");
    expect(config.presets.second.heavy.variant).toBe("thinking");
    expect(config.rules).toEqual(["legacy rule"]);
    expect(config.taskPatterns?.fast).toEqual(["lookup"]);
    expect(config.tierCaps).toEqual({ fast: 8, medium: 5, heavy: 3 });
  });

  it("supplies the five default roles and legacy aliases for v1", () => {
    const config = validateConfig(v1());

    expect(Object.keys(config.roles)).toEqual([
      "explore",
      "research",
      "implementation",
      "architecture",
      "review",
    ]);
    expect(config.roles.explore).toMatchObject({
      defaultTier: "fast",
      allowedTiers: ["fast", "medium"],
    });
    expect(config.roles.implementation.allowedTiers).toEqual(["fast", "medium", "heavy"]);
    expect(config.compatibility.aliases).toEqual({
      fast: { role: "explore", tier: "fast", agentName: "explore-fast" },
      medium: {
        role: "implementation",
        tier: "medium",
        agentName: "implementation-medium",
      },
      heavy: { role: "architecture", tier: "heavy", agentName: "architecture-heavy" },
    });
  });

  it("maps legacy caps to canonical tier budgets without removing the old projection", () => {
    const config = validateConfig(v1());

    expect(config.budgets.tiers).toEqual({
      fast: { localRead: 8 },
      medium: { localRead: 5 },
      heavy: { localRead: 3 },
    });
    expect(config.compatibility.warnings.map((warning) => warning.code)).toContain(
      "legacy-tier-cap-expanded",
    );
  });

  it("merges explicit canonical budgets into a declared v1 cap mapping", () => {
    const config = validateConfig(
      v1({
        schemaVersion: 1,
        budgets: { tiers: { fast: { commandExecution: 2 } } },
      }),
    );
    expect(config.budgets.tiers.fast).toEqual({ localRead: 8, commandExecution: 2 });
  });

  it("normalizes a v2 top-level model map and synthesizes its active preset", () => {
    const config = validateConfig(v2());

    expect(config.activePreset).toBe("test");
    expect(config.presets.test.fast).toEqual(config.models.fast);
    expect(config.models.medium).toMatchObject({
      model: "test/medium",
      costRatio: 5,
      description: "medium model tier",
      whenToUse: [],
    });
    expect(config.compatibility.sourceSchemas).toEqual([2]);
  });

  it("applies partial preset and role model overrides over top-level models", () => {
    const config = validateConfig(
      v2({
        presets: { test: { medium: { variant: "high" } } },
        roles: {
          implementation: {
            modelOverrides: { medium: { model: "test/implementation-medium" } },
          },
        },
      }),
    );

    expect(config.presets.test.medium).toMatchObject({ model: "test/medium", variant: "high" });
    expect(config.roles.implementation.modelOverrides.medium).toEqual({
      model: "test/implementation-medium",
    });
  });

  it("can disable synthesized legacy aliases in v2", () => {
    const config = validateConfig(v2({ compatibility: { legacyAliases: false } }));
    expect(config.compatibility.aliases).toEqual({});
  });

  it("retains unknown legacy extension fields", () => {
    const config = validateConfig(v1({ extensionField: { enabled: true } }));
    expect((config as unknown as Record<string, unknown>).extensionField).toEqual({ enabled: true });
  });

  it("preserves legacy model IDs while still requiring all v1 root fields", () => {
    const legacy = v1();
    const presets = legacy.presets as Record<string, Record<string, Record<string, unknown>>>;
    presets.first!.fast!.model = "legacy-model-name";
    expect(validateConfig(legacy).models.fast.model).toBe("legacy-model-name");

    const missingRules = v1();
    delete (missingRules as Record<string, unknown>).rules;
    expect(() => validateConfig(missingRules)).toThrow(/rules/);

    const missingDefault = v1();
    delete (missingDefault as Record<string, unknown>).defaultTier;
    expect(() => validateConfig(missingDefault)).toThrow(/defaultTier/);
  });

  it("adapts inherited role tiers for custom models in partial role patches", () => {
    const config = validateConfig({
      schemaVersion: 2,
      activePreset: "custom",
      models: { cheap: model("test/cheap") },
      roles: { explore: { description: "Custom exploration" } },
    });

    expect(config.roles.explore).toMatchObject({
      description: "Custom exploration",
      defaultTier: "cheap",
      allowedTiers: ["cheap"],
    });
    expect(config.compatibility.aliases).toEqual({});
    expect(config.compatibility.warnings.map((warning) => warning.code)).not.toContain(
      "legacy-tier-alias",
    );
  });
});

describe("canonical cross-reference validation", () => {
  it("rejects unsupported schema versions and malformed model IDs", () => {
    expect(() => validateConfig(v2({ schemaVersion: 3 }))).toThrow(/schemaVersion/);
    expect(() => validateConfig(v2({ models: { fast: model("missing-provider") } }))).toThrow(
      /provider\/model-id/,
    );
  });

  it("rejects invalid canonical model settings", () => {
    expect(() => validateConfig(v2WithFast({ costRatio: 0 }))).toThrow(/costRatio/);
    expect(() => validateConfig(v2WithFast({ steps: 0 }))).toThrow(/steps/);
    expect(() => validateConfig(v2WithFast({ prompt: 1 }))).toThrow(/prompt/);
    expect(() => validateConfig(v2WithFast({ whenToUse: [""] }))).toThrow(/empty strings/);
  });

  it("rejects missing role tiers and unsupported role defaults", () => {
    expect(() =>
      validateConfig(v2({ roles: { explore: { allowedTiers: ["missing"] } } })),
    ).toThrow(/roles\.explore\.allowedTiers.*missing tier/);
    expect(() =>
      validateConfig(
        v2({ roles: { explore: { defaultTier: "heavy", allowedTiers: ["fast"] } } }),
      ),
    ).toThrow(/roles\.explore\.defaultTier.*allowedTiers/);
    expect(() =>
      validateConfig(v2({ roles: { explore: { allowedTiers: [] } } })),
    ).toThrow(/allowedTiers.*must not be empty/);
    expect(() =>
      validateConfig(v2({ roles: { explore: { allowedTiers: ["fast", "fast"] } } })),
    ).toThrow(/allowedTiers.*duplicates/);
    expect(() =>
      validateConfig(
        v2({ roles: { explore: { modelOverrides: { heavy: { variant: "high" } } } } }),
      ),
    ).toThrow(/modelOverrides\.heavy.*not allowed/);
  });

  it("rejects missing root and mode default tiers", () => {
    expect(() => validateConfig(v2({ defaultTier: "missing" }))).toThrow(/defaultTier/);
    expect(() =>
      validateConfig(
        v2({
          activeMode: "bad",
          modes: { bad: { defaultTier: "missing", description: "bad mode" } },
        }),
      ),
    ).toThrow(/modes\.bad\.defaultTier/);
  });

  it("rejects invalid delegation edges", () => {
    expect(() =>
      validateConfig(
        v2({ delegation: { maxDepth: 2, allowedChildren: { implementation: ["implementation"] } } }),
      ),
    ).toThrow(/self-delegation/);
    expect(() =>
      validateConfig(
        v2({ delegation: { maxDepth: 2, allowedChildren: { implementation: ["missing"] } } }),
      ),
    ).toThrow(/unknown role 'missing'/);
    expect(() =>
      validateConfig(v2({ delegation: { maxDepth: 0 } })),
    ).toThrow(/delegation\.maxDepth/);
    expect(() =>
      validateConfig(
        v2({ delegation: { maxDepth: 2, allowedChildren: { review: ["implementation"] } } }),
      ),
    ).toThrow(/does not allow delegation/);
    expect(() =>
      validateConfig(
        v2({ delegation: { maxDepth: 2, allowedChildren: { implementation: ["research"] } } }),
      ),
    ).not.toThrow();
  });

  it("rejects invalid role and MCP pattern definitions", () => {
    expect(() =>
      validateConfig(v2({ roles: { explore: { taskPatterns: ["find", 1] } } })),
    ).toThrow(/taskPatterns/);
    expect(() =>
      validateConfig(
        v2({
          roles: {
            explore: { tools: { allowPatterns: ["read"], denyPatterns: ["read"] } },
          },
        }),
      ),
    ).toThrow(/both allow and deny/);
    expect(() =>
      validateConfig(
        v2({
          tools: {
            mcp: {
              custom: { readPatterns: ["custom_*"], writePatterns: ["custom_*"] },
            },
          },
        }),
      ),
    ).toThrow(/same pattern/);
    expect(() =>
      validateConfig(
        v2({ roles: { explore: { tools: { allowCategories: ["missing"] } } } }),
      ),
    ).toThrow(/unknown category/);
    expect(() =>
      validateConfig(
        v2({ roles: { explore: { tools: { allowMcp: ["missing"] } } } }),
      ),
    ).toThrow(/unknown MCP/);
    expect(() =>
      validateConfig(v2({ tools: { categories: { missing: ["tool"] } } })),
    ).toThrow(/supported tool category/);
    expect(() =>
      validateConfig(v2({ tools: { mcp: { custom: {} } } })),
    ).toThrow(/at least one read or write pattern/);
    expect(() =>
      validateConfig(
        v2({ tools: { mcp: { custom: { readPatterns: ["custom_*"], readCategory: "bad" } } } }),
      ),
    ).toThrow(/readCategory/);
    expect(() =>
      validateConfig(
        v2({ tools: { mcp: { custom: { writePatterns: ["custom_*"], writeCategory: "bad" } } } }),
      ),
    ).toThrow(/writeCategory/);
  });

  it("rejects invalid budget definitions and references", () => {
    expect(() =>
      validateConfig(v2({ budgets: { roles: { explore: { localRead: -1 } } } })),
    ).toThrow(/localRead.*greater than or equal to zero/);
    expect(() =>
      validateConfig(v2({ budgets: { roles: { missing: { localRead: 1 } } } })),
    ).toThrow(/budgets\.roles\.missing/);
    expect(() =>
      validateConfig(v2({ budgets: { tiers: { missing: { localRead: 1 } } } })),
    ).toThrow(/budgets\.tiers\.missing/);
    expect(() =>
      validateConfig(v2({ budgets: { global: { unsupported: 1 } } })),
    ).toThrow(/supported budget category/);
    expect(() =>
      validateConfig(
        v2({ budgets: { roleTiers: { missing: { fast: { localRead: 1 } } } } }),
      ),
    ).toThrow(/budgets\.roleTiers\.missing/);
    expect(() =>
      validateConfig(
        v2({ budgets: { roleTiers: { explore: { missing: { localRead: 1 } } } } }),
      ),
    ).toThrow(/budgets\.roleTiers\.explore\.missing/);
  });

  it("rejects invalid enforcement tier references", () => {
    expect(() =>
      validateConfig(
        v2({ enforcement: { escalate: { ladder: ["fast", "missing"] } } }),
      ),
    ).toThrow(/escalate\.ladder.*missing tier/);
    expect(() =>
      validateConfig(
        v2({ enforcement: { escalate: { ladder: ["fast", "fast"] } } }),
      ),
    ).toThrow(/must not contain duplicates/);
    expect(() =>
      validateConfig(
        v2({
          enforcement: {
            escalate: { ladder: ["fast", "medium"], floorTier: "heavy" },
          },
        }),
      ),
    ).toThrow(/floorTier.*escalation ladder/);
  });

  it("validates compatibility fields in v2 documents", () => {
    expect(() => validateConfig(v2({ taskPatterns: { medium: 3 } }))).toThrow(
      /taskPatterns/,
    );
    expect(() => validateConfig(v2({ tierCaps: { fast: "many" } }))).toThrow(/tierCaps/);
    expect(() => validateConfig(v2({ tierPrompts: { fast: 1 } }))).toThrow(/tierPrompts/);
    expect(() => validateConfig(v2({ enforcement: "enabled" }))).toThrow(/enforcement/);
    expect(() => validateConfig(v2({ fallback: { global: { test: "other" } } }))).toThrow(
      /fallback\.global\.test/,
    );
    expect(() => validateConfig(v2({ experimental: { verifiedDelegateTool: "yes" } }))).toThrow(
      /verifiedDelegateTool/,
    );
    expect(() => validateConfig(v2({ compatibility: { legacyAliases: "yes" } }))).toThrow(
      /legacyAliases/,
    );
  });

  it("rejects preset overrides for undefined top-level tiers", () => {
    expect(() =>
      validateConfig(v2({ presets: { test: { extra: model("test/extra") } } })),
    ).toThrow(/presets\.test\.extra.*top-level models/);
  });

  it("validates explicit compatibility aliases", () => {
    expect(() =>
      validateConfig(
        v2({ compatibility: { aliases: { custom: { role: 1, tier: "fast" } } } }),
      ),
    ).toThrow(/aliases\.custom\.role/);
    expect(() =>
      validateConfig(
        v2({ compatibility: { aliases: { custom: { role: "missing", tier: "fast" } } } }),
      ),
    ).toThrow(/unknown role/);
    expect(() =>
      validateConfig(
        v2({ compatibility: { aliases: { custom: { role: "explore", tier: "heavy" } } } }),
      ),
    ).toThrow(/not allowed for the alias role/);
  });
});
