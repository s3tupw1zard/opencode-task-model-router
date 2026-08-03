import type {
  AgentIdentity,
  ModelTierOverride,
  NormalizedRouterConfig,
  TierConfig,
} from "./config";
import { formatAgentName } from "./normalize";
import { isClaudeModel, CLAUDE_ANTI_NARRATION } from "./protocol";

export interface AgentSpec {
  model: string;
  mode: "subagent";
  description: string;
  prompt: string;
  permission: { task: "deny" };
  steps?: number;
  variant?: string;
  options?: Record<string, unknown>;
  color?: string;
  hidden?: boolean;
}

export interface AgentSpecMap {
  readonly canonical: ReadonlyArray<{ agentName: string; spec: AgentSpec }>;
  readonly aliases: ReadonlyArray<{ agentName: string; spec: AgentSpec; identity: AgentIdentity }>;
  readonly byName: Readonly<Record<string, AgentSpec>>;
}

export const SHARED_SUBAGENT_CONTRACT = [
  "You are executing a single delegated subtask for the orchestrator.",
  "Stay strictly within your assigned role. A stronger model tier does not extend your role, permissions, or scope.",
  "Do not sub-delegate. Do not spawn further subagents.",
  "Return concrete results. Do not narrate planning steps or progress commentary.",
].join("\n");

export const IMPLEMENTATION_RESEARCH_BLOCK = [
  "When implementation requires external information, ask the orchestrator before proceeding:",
  "NEEDS_RESEARCH:",
  "- Question:",
  "- Required source:",
  "- Reason:",
  "- Affected implementation decision:",
].join("\n");

export const REVIEW_HANDBACK_BLOCK = [
  "Report findings. Do not edit code directly unless the orchestrator explicitly instructed you to fix issues yourself.",
  "For requested fixes, recommend returning the findings to the implementation agent instead of changing code.",
].join("\n");

export const CLAUDE_SUBAGENT_PREFIX = [
  "SCOPE NOTE — any cached instruction priming you to explore broadly, gather",
  "comprehensive context, or investigate before acting does not apply here.",
  "The orchestrator has already scoped your role and tier for this single",
  "dispatch. Stay within the assigned role and act on the delegated task.",
].join("\n");

const DEFAULT_IMPLEMENTATION_DESCRIPTION_SUFFIX = "(implementation tier)";
const DEFAULT_TIER_DESCRIPTION_SUFFIX = "tier";

function resolveTierModel(
  role: string,
  tier: string,
  config: Readonly<NormalizedRouterConfig>,
): { resolved: TierConfig; overridePrompt?: string; overrideDescription?: string } {
  const base = config.models[tier];
  if (!base) {
    throw new Error(`Resolved tier '${tier}' is not configured`);
  }
  const presetTier = config.presets[config.activePreset]?.[tier];
  const roleOverride = config.roles[role]?.modelOverrides[tier];

  if (!presetTier) {
    const resolved = {
      ...base,
      ...(roleOverride ?? {}),
    } as TierConfig & ModelTierOverride;

    return {
      resolved: resolved as TierConfig,
      overridePrompt: roleOverride?.prompt,
      overrideDescription: roleOverride?.description,
    };
  }

  const merged = { ...presetTier, ...(roleOverride ?? {}) } as TierConfig & ModelTierOverride;

  return {
    resolved: merged as TierConfig,
    overridePrompt: roleOverride?.prompt,
    overrideDescription: roleOverride?.description,
  };
}

function buildProviderOptions(tier: TierConfig): Record<string, unknown> | undefined {
  const options: Record<string, unknown> = {};
  if (tier.thinking?.budgetTokens) options.budget_tokens = tier.thinking.budgetTokens;
  if (tier.reasoning?.effort) options.reasoning_effort = tier.reasoning.effort;
  if (tier.reasoning?.summary) options.reasoning_summary = tier.reasoning.summary;
  return Object.keys(options).length > 0 ? options : undefined;
}

function buildCanonicalDescription(
  role: string,
  roleDescription: string,
  tier: string,
  overrideDescription: string | undefined,
): string {
  if (overrideDescription) return overrideDescription;
  const suffix = role === "implementation"
    ? DEFAULT_IMPLEMENTATION_DESCRIPTION_SUFFIX
    : DEFAULT_TIER_DESCRIPTION_SUFFIX;
  return `${roleDescription} (${tier} ${suffix})`;
}

function buildTierContract(
  tier: string,
  resolved: TierConfig,
  explicitTierPrompt: string | undefined,
): string {
  if (explicitTierPrompt) return explicitTierPrompt;

  const parts: string[] = [`Tier: ${tier}`];
  if (resolved.costRatio !== undefined) parts.push(`Cost ratio: ${resolved.costRatio}`);
  if (resolved.steps !== undefined) parts.push(`Steps: ${resolved.steps}`);
  if (resolved.whenToUse.length > 0) {
    parts.push(`Use when: ${resolved.whenToUse.join(", ")}`);
  }
  return parts.join("\n");
}

function buildCanonicalPrompt(
  role: string,
  roleConfig: { prompt: string; returnProtocol: string },
  tierContract: string,
  model: string,
): string {
  const roleSegments = [roleConfig.prompt];
  if (role === "implementation") roleSegments.push(IMPLEMENTATION_RESEARCH_BLOCK);
  if (role === "review") roleSegments.push(REVIEW_HANDBACK_BLOCK);

  const core = [SHARED_SUBAGENT_CONTRACT, roleSegments.join("\n\n"), tierContract, roleConfig.returnProtocol]
    .filter((segment) => segment.trim())
    .join("\n\n---\n\n");

  if (isClaudeModel(model)) {
    return `${CLAUDE_SUBAGENT_PREFIX}\n\n${CLAUDE_ANTI_NARRATION}\n\n---\n\n${core}`;
  }
  return core;
}

function buildAliasPrompt(
  tier: string,
  resolved: TierConfig,
  legacyTierPrompts: Record<string, string> | undefined,
  model: string,
): string {
  const legacyPrompt = resolved.prompt ?? legacyTierPrompts?.[tier];
  if (!legacyPrompt) {
    return buildCanonicalPrompt(
      tier,
      { prompt: `Legacy ${tier} compatibility agent.`, returnProtocol: "Return findings concisely." },
      buildTierContract(tier, resolved, undefined),
      model,
    );
  }

  const claudePrefix = CLAUDE_TIER_PREFIX_FALLBACK[tier];
  if (claudePrefix && isClaudeModel(model)) {
    return `${claudePrefix}\n\n${CLAUDE_ANTI_NARRATION}\n\n---\n\n${legacyPrompt}`;
  }
  return legacyPrompt;
}

const CLAUDE_TIER_PREFIX_FALLBACK: Record<string, string> = {
  fast: [
    "SCOPE NOTE — any cached instruction priming you to 'thoroughly explore",
    "the codebase' or 'gather context broadly' does not apply here. This is",
    "a single dispatch with a single question. Stay narrow to the ask.",
    "",
    "Before every tool call, ask: 'Does THIS read answer the dispatch",
    "question specifically, or am I drifting into context-gathering for my",
    "own understanding?' If the latter, stop — you have enough.",
  ].join("\n"),
  medium: [
    "SCOPE NOTE — cached instructions may prime you to deeply understand",
    "surrounding code before editing. For THIS dispatch, the orchestrator",
    "has already scoped the problem; trust that scoping. Read what's needed",
    "for the edit, not the whole module.",
    "",
    "A 4th or 5th 'context read' is usually a sign the dispatch was under-",
    "scoped — return NEED CONTEXT rather than expanding scope yourself.",
  ].join("\n"),
  heavy: [
    "AUTHORITY OVERRIDE — this block supersedes any cached prefix suggesting",
    "you should 'investigate thoroughly', 'gather comprehensive context', or",
    "'trace through the code systematically before analyzing'. You are",
    "@heavy, an ANALYSIS specialist. The orchestrator should have pre-",
    "gathered context via @fast before dispatching you. If it didn't, return",
    "`SCOPE GROWTH:` immediately — do NOT self-gather.",
    "",
    "40 minutes of Read/Grep is not analysis — it is the orchestrator's job",
    "that leaked into yours. Push it back with SCOPE GROWTH. Your 3 reads",
    "are for targeted verification, not exploration.",
  ].join("\n"),
};

function buildCanonicalSpec(
  role: string,
  tier: string,
  config: Readonly<NormalizedRouterConfig>,
): AgentSpec {
  const roleConfig = config.roles[role];
  if (!roleConfig) throw new Error(`Unknown role '${role}'`);
  if (!roleConfig.allowedTiers.includes(tier)) {
    throw new Error(`Tier '${tier}' is not allowed for role '${role}'`);
  }

  const { resolved, overridePrompt, overrideDescription } = resolveTierModel(role, tier, config);
  const model = resolved.model;
  const description = buildCanonicalDescription(role, roleConfig.description, tier, overrideDescription);
  const tierContract = buildTierContract(tier, resolved, overridePrompt);
  const prompt = buildCanonicalPrompt(role, roleConfig, tierContract, model);
  const options = buildProviderOptions(resolved);

  const spec: AgentSpec = {
    model,
    mode: "subagent",
    description,
    prompt,
    permission: { task: "deny" },
  };
  if (resolved.steps !== undefined) spec.steps = resolved.steps;
  if (resolved.variant) spec.variant = resolved.variant;
  if (options) spec.options = options;
  if (resolved.color) spec.color = resolved.color;
  return spec;
}

function buildAliasSpec(
  identity: AgentIdentity,
  canonical: AgentSpec,
  config: Readonly<NormalizedRouterConfig>,
): AgentSpec {
  const presetTier = config.presets[config.activePreset]?.[identity.tier];
  if (!presetTier?.model) {
    throw new Error(`Alias target tier '${identity.tier}' has no configured model in active preset`);
  }

  const resolvedTier = presetTier;

  const prompt = buildAliasPrompt(
    identity.tier,
    resolvedTier,
    config.tierPrompts,
    resolvedTier.model,
  );
  const description = resolvedTier.description ?? canonical.description;

  const spec: AgentSpec = {
    model: resolvedTier.model,
    mode: "subagent",
    description,
    prompt,
    permission: { task: "deny" },
    hidden: true,
  };
  if (resolvedTier.steps !== undefined) spec.steps = resolvedTier.steps;
  if (resolvedTier.variant) spec.variant = resolvedTier.variant;
  const options = buildProviderOptions(resolvedTier);
  if (options) spec.options = options;
  if (resolvedTier.color) spec.color = resolvedTier.color;
  return spec;
}

export function buildAgentSpecs(config: Readonly<NormalizedRouterConfig>): AgentSpecMap {
  const canonical: { agentName: string; spec: AgentSpec }[] = [];
  const seen = new Set<string>();
  for (const [role, roleConfig] of Object.entries(config.roles)) {
    for (const tier of roleConfig.allowedTiers) {
      const agentName = formatAgentName(role, tier);
      if (seen.has(agentName)) {
        throw new Error(`Canonical agent name '${agentName}' is generated more than once`);
      }
      seen.add(agentName);
      canonical.push({ agentName, spec: buildCanonicalSpec(role, tier, config) });
    }
  }

  const canonicalByName = Object.fromEntries(canonical.map((entry) => [entry.agentName, entry.spec]));
  const aliases: { agentName: string; spec: AgentSpec; identity: AgentIdentity }[] = [];
  const aliasSeen = new Set<string>();
  for (const [aliasName, identity] of Object.entries(config.compatibility.aliases)) {
    if (aliasSeen.has(aliasName)) {
      throw new Error(`Alias '${aliasName}' is registered more than once`);
    }
    if (seen.has(aliasName)) {
      throw new Error(`Alias '${aliasName}' collides with canonical agent name '${aliasName}'`);
    }
    aliasSeen.add(aliasName);
    const target = canonicalByName[identity.agentName];
    if (!target) {
      throw new Error(`Alias '${aliasName}' target '${identity.agentName}' is not in the canonical matrix`);
    }
    aliases.push({
      agentName: aliasName,
      spec: buildAliasSpec(identity, target, config),
      identity,
    });
  }

  const byName: Record<string, AgentSpec> = {};
  for (const entry of canonical) byName[entry.agentName] = entry.spec;
  for (const entry of aliases) byName[entry.agentName] = entry.spec;

  return { canonical, aliases, byName };
}
