import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { validateConfig } from "../../src/router/config";
import { buildAgentSpecs } from "../../src/router/agents";

describe("agent prompts golden", () => {
  const raw = JSON.parse(
    readFileSync(join(process.cwd(), "tiers.json"), "utf-8"),
  );
  const base = validateConfig(raw);

  it("anthropic-canonical-prompts", () => {
    const cfg = { ...base, activePreset: "anthropic", activeMode: undefined };
    const specs = buildAgentSpecs(cfg);
    const prompts: Record<string, string> = {};
    for (const entry of specs.canonical) {
      prompts[entry.agentName] = entry.spec.prompt;
    }
    expect(prompts).toMatchSnapshot("anthropic-canonical-prompts");
  });

  it("anthropic-alias-prompts", () => {
    const cfg = { ...base, activePreset: "anthropic", activeMode: undefined };
    const specs = buildAgentSpecs(cfg);
    const prompts: Record<string, string> = {};
    for (const entry of specs.aliases) {
      prompts[entry.agentName] = entry.spec.prompt;
    }
    expect(prompts).toMatchSnapshot("anthropic-alias-prompts");
  });

  it("openai-canonical-prompts", () => {
    const cfg = { ...base, activePreset: "openai", activeMode: undefined };
    const specs = buildAgentSpecs(cfg);
    const prompts: Record<string, string> = {};
    for (const entry of specs.canonical) {
      prompts[entry.agentName] = entry.spec.prompt;
    }
    expect(prompts).toMatchSnapshot("openai-canonical-prompts");
  });

  it("hybrid-canonical-prompts", () => {
    const cfg = { ...base, activePreset: "hybrid", activeMode: undefined };
    const specs = buildAgentSpecs(cfg);
    const prompts: Record<string, string> = {};
    for (const entry of specs.canonical) {
      prompts[entry.agentName] = entry.spec.prompt;
    }
    expect(prompts).toMatchSnapshot("hybrid-canonical-prompts");
  });

  it("canonical-prompt-segment-order", () => {
    const cfg = { ...base, activePreset: "anthropic", activeMode: undefined };
    const specs = buildAgentSpecs(cfg);

    for (const entry of specs.canonical) {
      const prompt = entry.spec.prompt;

      if (entry.agentName.startsWith("implementation-")) {
        expect(prompt).toContain("NEEDS_RESEARCH:");
      } else {
        expect(prompt).not.toContain("NEEDS_RESEARCH:");
      }

      if (entry.agentName.startsWith("review-")) {
        expect(prompt).toContain("Report findings. Do not edit code directly");
      } else {
        expect(prompt).not.toContain("Report findings. Do not edit code directly");
      }
    }
  });

  it("alias-prompts-use-legacy-tier-prompts", () => {
    const cfg = { ...base, activePreset: "anthropic", activeMode: undefined };
    const specs = buildAgentSpecs(cfg);

    for (const entry of specs.aliases) {
      const tierPrompt = cfg.tierPrompts?.[entry.identity.tier];
      expect(tierPrompt).toBeDefined();
      expect(entry.spec.prompt).toContain(tierPrompt!);
    }
  });

  it("canonical-claude-prefix-is-role-neutral", () => {
    const cfg = { ...base, activePreset: "anthropic", activeMode: undefined };
    const specs = buildAgentSpecs(cfg);

    for (const entry of specs.canonical) {
      if (entry.spec.model.startsWith("anthropic/")) {
        const prompt = entry.spec.prompt;
        expect(prompt).toContain("Stay within the assigned role");
        expect(prompt).not.toContain("@fast — a read-only exploration");
        expect(prompt).not.toContain("@medium — an implementation specialist");
        expect(prompt).not.toContain("@heavy — a senior architecture");
      }
    }
  });

  it("custom-claude-tier-does-not-produce-undefined-prefix", () => {
    const cfg = validateConfig({
      schemaVersion: 2,
      activePreset: "test",
      models: {
        fast: { model: "anthropic/claude-haiku-4-5", costRatio: 1, description: "fast", whenToUse: [] },
      },
      roles: {
        exploration: {
          description: "Explore the code",
          prompt: "Explore and return findings.",
          returnProtocol: "Return findings.",
          defaultTier: "fast",
          allowedTiers: ["fast"],
          taskPatterns: ["find"],
        },
      },
      compatibility: { legacyAliases: false },
    });
    const specs = buildAgentSpecs(cfg);
    const prompt = specs.byName["exploration-fast"]?.prompt ?? "";
    expect(prompt).not.toContain("undefined");
    expect(prompt).toContain("SCOPE NOTE");
  });
});
