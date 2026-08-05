import { describe, expect, test } from "bun:test";
import { resolveRoleFromAgentName } from "../src/router/tool-policy";
import type { NormalizedRoleConfig } from "../src/router/config";

describe("resolveRoleFromAgentName", () => {
  const baseRole: NormalizedRoleConfig = {
    description: "Test role",
    prompt: "Test prompt",
    returnProtocol: "Test protocol",
    defaultTier: "fast",
    allowedTiers: ["fast", "medium"],
    taskPatterns: [],
    modelOverrides: {},
    tools: {
      allowCategories: [],
      denyCategories: [],
      allowMcp: [],
      denyMcp: [],
      allowPatterns: [],
      denyPatterns: [],
      allowCommands: [],
      denyCommands: [],
    },
  };

  const baseCfg = {
    compatibility: {
      aliases: {
        fast: { role: "explore", tier: "fast", agentName: "explore-fast" },
        medium: { role: "implementation", tier: "medium", agentName: "implementation-medium" },
        heavy: { role: "architecture", tier: "heavy", agentName: "architecture-heavy" },
      },
    },
    roles: {
      explore: { ...baseRole, allowedTiers: ["fast", "medium"] },
      implementation: { ...baseRole, allowedTiers: ["fast", "medium", "heavy"] },
      architecture: { ...baseRole, allowedTiers: ["heavy"] },
    },
  };

  describe("canonical agent names", () => {
    test("resolves explore-fast to explore role", () => {
      const result = resolveRoleFromAgentName("explore-fast", baseCfg);
      expect(result).toBe("explore");
    });

    test("resolves implementation-medium to implementation role", () => {
      const result = resolveRoleFromAgentName("implementation-medium", baseCfg);
      expect(result).toBe("implementation");
    });

    test("resolves architecture-heavy to architecture role", () => {
      const result = resolveRoleFromAgentName("architecture-heavy", baseCfg);
      expect(result).toBe("architecture");
    });
  });

  describe("legacy aliases", () => {
    test("resolves 'fast' alias to explore role", () => {
      const result = resolveRoleFromAgentName("fast", baseCfg);
      expect(result).toBe("explore");
    });

    test("resolves 'medium' alias to implementation role", () => {
      const result = resolveRoleFromAgentName("medium", baseCfg);
      expect(result).toBe("implementation");
    });

    test("resolves 'heavy' alias to architecture role", () => {
      const result = resolveRoleFromAgentName("heavy", baseCfg);
      expect(result).toBe("architecture");
    });
  });

  describe("custom alias names", () => {
    test("resolves custom alias to target role", () => {
      const cfg = {
        ...baseCfg,
        compatibility: {
          aliases: {
            "my-fast": { role: "explore", tier: "fast", agentName: "explore-fast" },
            "my-custom": { role: "implementation", tier: "medium", agentName: "my-custom-target" },
          },
        },
      };
      expect(resolveRoleFromAgentName("my-fast", cfg)).toBe("explore");
      expect(resolveRoleFromAgentName("my-custom", cfg)).toBe("implementation");
    });

    test("resolves alias by target agent name", () => {
      const cfg = {
        ...baseCfg,
        compatibility: {
          aliases: {
            "my-alias": { role: "explore", tier: "fast", agentName: "explore-fast" },
          },
        },
      };
      // Can resolve by alias name
      expect(resolveRoleFromAgentName("my-alias", cfg)).toBe("explore");
      // Can also resolve by target agent name
      expect(resolveRoleFromAgentName("explore-fast", cfg)).toBe("explore");
    });
  });

  describe("roles and tiers with hyphens", () => {
    test("resolves role with hyphen", () => {
      const cfg = {
        ...baseCfg,
        roles: {
          ...baseCfg.roles,
          "code-review": { ...baseRole, allowedTiers: ["fast", "medium"] },
        },
      };
      const result = resolveRoleFromAgentName("code-review-fast", cfg);
      expect(result).toBe("code-review");
    });

    test("resolves tier with hyphen", () => {
      const cfg = {
        ...baseCfg,
        roles: {
          explore: { ...baseRole, allowedTiers: ["fast", "mid-weight"] },
        },
      };
      const result = resolveRoleFromAgentName("explore-mid-weight", cfg);
      expect(result).toBe("explore");
    });

    test("resolves both role and tier with hyphens", () => {
      const cfg = {
        ...baseCfg,
        roles: {
          ...baseCfg.roles,
          "code-review": { ...baseRole, allowedTiers: ["mid-weight"] },
        },
      };
      const result = resolveRoleFromAgentName("code-review-mid-weight", cfg);
      expect(result).toBe("code-review");
    });
  });

  describe("unknown agent names", () => {
    test("returns null for unknown agent name", () => {
      const result = resolveRoleFromAgentName("unknown-agent", baseCfg);
      expect(result).toBeNull();
    });

    test("returns null for empty string", () => {
      const result = resolveRoleFromAgentName("", baseCfg);
      expect(result).toBeNull();
    });

    test("returns null for partial match", () => {
      const result = resolveRoleFromAgentName("explore", baseCfg);
      expect(result).toBeNull();
    });

    test("returns null for tier only", () => {
      const result = resolveRoleFromAgentName("fast", {
        ...baseCfg,
        compatibility: { aliases: {} }, // no aliases
      });
      expect(result).toBeNull();
    });
  });

  describe("stale session data after config change", () => {
    test("returns null when role was removed from config", () => {
      // Session has agentName "explore-fast" but role "explore" was removed
      const cfg = {
        ...baseCfg,
        roles: {
          implementation: baseCfg.roles.implementation,
          // explore role removed
        },
      };
      const result = resolveRoleFromAgentName("explore-fast", cfg);
      expect(result).toBeNull();
    });

    test("returns null when tier was removed from role", () => {
      // Session has agentName "explore-fast" but tier "fast" was removed from role
      const cfg = {
        ...baseCfg,
        roles: {
          explore: { ...baseRole, allowedTiers: ["medium"] }, // fast removed
        },
      };
      const result = resolveRoleFromAgentName("explore-fast", cfg);
      expect(result).toBeNull();
    });

    test("returns null when alias was removed", () => {
      // Session has agentName "fast" but alias was removed
      const cfg = {
        ...baseCfg,
        compatibility: {
          aliases: {
            medium: baseCfg.compatibility.aliases.medium,
            // fast alias removed
          },
        },
      };
      const result = resolveRoleFromAgentName("fast", cfg);
      expect(result).toBeNull();
    });
  });
});
