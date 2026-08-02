import type { AgentIdentity, NormalizedRouterConfig } from "./config";

export type RoutingErrorCode =
  | "unknown-role"
  | "unknown-tier"
  | "conflicting-role-directives"
  | "conflicting-tier-directives"
  | "ambiguous-role"
  | "unsupported-role-tier"
  | "missing-tier-order";

export class RoutingError extends Error {
  constructor(
    public readonly code: RoutingErrorCode,
    message: string,
    public readonly role?: string,
    public readonly tier?: string,
  ) {
    super(message);
    this.name = "RoutingError";
  }
}

type DirectiveKind = "role" | "tier";

const DIRECTIVE_PATTERN = /\[\s*(role|tier)\s*:\s*([^\]]+?)\s*\]/giu;
const LEGACY_DEFAULT_LADDER = ["fast", "medium", "heavy"] as const;

function maskBacktickCode(text: string): string {
  let result = "";
  let offset = 0;
  while (offset < text.length) {
    if (text[offset] !== "`") {
      result += text[offset];
      offset += 1;
      continue;
    }

    let delimiterLength = 1;
    while (text[offset + delimiterLength] === "`") delimiterLength += 1;
    const delimiter = "`".repeat(delimiterLength);
    let closing = text.indexOf(delimiter, offset + delimiterLength);
    while (
      closing >= 0 &&
      (text[closing - 1] === "`" || text[closing + delimiterLength] === "`")
    ) {
      closing = text.indexOf(delimiter, closing + delimiterLength);
    }
    if (closing < 0) {
      if (delimiterLength >= 3) return `${result} `;
      result += delimiter;
      offset += delimiterLength;
      continue;
    }
    result += " ";
    offset = closing + delimiterLength;
  }
  return result;
}

function maskMarkdownCode(text: string): string {
  let fence: { marker: string; length: number } | undefined;
  const withoutBlocks = text.split("\n").map((line) => {
    const content = line.replace(/^(?: {0,3}> ?)+/u, "");
    if (fence) {
      const closing = content.match(/^ {0,3}(`+|~+)\s*$/u)?.[1];
      if (closing?.[0] === fence.marker && closing.length >= fence.length) fence = undefined;
      return " ";
    }

    const opening = content.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (opening) {
      fence = { marker: opening[0]!, length: opening.length };
      return " ";
    }
    if (/^(?: {4}|\t)/u.test(content)) return " ";
    return line;
  }).join("\n");
  return maskBacktickCode(withoutBlocks);
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function classificationText(task: string): string {
  return normalizedText(maskMarkdownCode(task).replace(DIRECTIVE_PATTERN, " "));
}

function resolveConfiguredName(
  rawName: string,
  names: readonly string[],
  kind: DirectiveKind,
): string {
  const requested = rawName.trim();
  const exact = names.find((name) => name === requested);
  if (exact) return exact;

  const matches = names.filter((name) => name.toLowerCase() === requested.toLowerCase());
  if (matches.length === 1) return matches[0]!;

  const code = kind === "role" ? "unknown-role" : "unknown-tier";
  throw new RoutingError(code, `Unknown ${kind} '${requested}'`, kind === "role" ? requested : undefined, kind === "tier" ? requested : undefined);
}

function explicitDirective(
  task: string,
  kind: DirectiveKind,
  names: readonly string[],
): string | undefined {
  const values: string[] = [];
  const visible = maskMarkdownCode(task);
  for (const match of visible.matchAll(DIRECTIVE_PATTERN)) {
    if (match[1]!.toLowerCase() !== kind) continue;
    values.push(resolveConfiguredName(match[2]!, names, kind));
  }
  if (values.length === 0) return undefined;

  const unique = [...new Set(values)];
  if (unique.length > 1) {
    const code = kind === "role"
      ? "conflicting-role-directives"
      : "conflicting-tier-directives";
    throw new RoutingError(code, `Conflicting ${kind} directives: ${unique.join(", ")}`);
  }
  return unique[0];
}

function effectiveTierLadder(config: Readonly<NormalizedRouterConfig>): string[] {
  const configured = config.enforcement?.escalate?.ladder;
  if (configured?.length) return [...configured];

  const tierNames = Object.keys(config.models);
  if (tierNames.length > 0 && tierNames.every((tier) => LEGACY_DEFAULT_LADDER.includes(tier as typeof LEGACY_DEFAULT_LADDER[number]))) {
    return LEGACY_DEFAULT_LADDER.filter((tier) => config.models[tier]);
  }

  return Object.entries(config.models)
    .sort(([leftName, left], [rightName, right]) => {
      const leftCost = left.costRatio ?? Number.POSITIVE_INFINITY;
      const rightCost = right.costRatio ?? Number.POSITIVE_INFINITY;
      return leftCost - rightCost || leftName.localeCompare(rightName);
    })
    .map(([name]) => name);
}

function tierRank(tier: string, ladder: readonly string[]): number {
  const rank = ladder.indexOf(tier);
  if (rank < 0) {
    throw new RoutingError(
      "missing-tier-order",
      `Tier '${tier}' is missing from the configured tier ladder`,
      undefined,
      tier,
    );
  }
  return rank;
}

function matchedTier(
  text: string,
  config: Readonly<NormalizedRouterConfig>,
): string | undefined {
  const matches = Object.entries(config.taskPatterns ?? {})
    .filter(([, patterns]) => patterns.some((pattern) => text.includes(normalizedText(pattern))))
    .map(([tier]) => tier);
  if (matches.length === 0) return undefined;

  for (const tier of matches) {
    if (!config.models[tier]) {
      throw new RoutingError("unknown-tier", `Task patterns reference unknown tier '${tier}'`, undefined, tier);
    }
  }
  if (matches.length === 1) return matches[0];

  const ladder = effectiveTierLadder(config);
  return matches.reduce((strongest, tier) =>
    tierRank(tier, ladder) > tierRank(strongest, ladder) ? tier : strongest,
  );
}

function adjustAutomaticTier(
  candidate: string,
  role: string,
  allowedTiers: readonly string[],
  config: Readonly<NormalizedRouterConfig>,
): string {
  const ladder = effectiveTierLadder(config);
  const candidateRank = tierRank(candidate, ladder);

  for (let rank = candidateRank + 1; rank < ladder.length; rank += 1) {
    if (allowedTiers.includes(ladder[rank]!)) return ladder[rank]!;
  }
  for (let rank = candidateRank - 1; rank >= 0; rank -= 1) {
    if (allowedTiers.includes(ladder[rank]!)) return ladder[rank]!;
  }

  throw new RoutingError(
    "missing-tier-order",
    `No allowed tier for role '${role}' is available in the configured tier ladder`,
    role,
    candidate,
  );
}

export function classifyTaskRole(
  task: string,
  config: Readonly<NormalizedRouterConfig>,
): string {
  const roleNames = Object.keys(config.roles);
  const explicit = explicitDirective(task, "role", roleNames);
  if (explicit) return explicit;

  const text = classificationText(task);
  const candidates = Object.entries(config.roles)
    .map(([role, value]) => {
      const matches = [...new Set(value.taskPatterns.map(normalizedText))]
        .filter((pattern) => pattern && text.includes(pattern));
      return {
        role,
        longest: matches.reduce((length, pattern) => Math.max(length, pattern.length), 0),
        count: matches.length,
      };
    })
    .filter((candidate) => candidate.count > 0)
    .sort((left, right) => right.longest - left.longest || right.count - left.count);

  if (candidates.length === 0) return config.defaultRole;
  const best = candidates[0]!;
  const tied = candidates.filter(
    (candidate) => candidate.longest === best.longest && candidate.count === best.count,
  );
  if (tied.length > 1) {
    throw new RoutingError(
      "ambiguous-role",
      `Task matches multiple roles equally: ${tied.map((candidate) => candidate.role).join(", ")}`,
    );
  }
  return best.role;
}

export function selectModelTier(
  task: string,
  role: string,
  config: Readonly<NormalizedRouterConfig>,
): string {
  const roleConfig = config.roles[role];
  if (!roleConfig) {
    throw new RoutingError("unknown-role", `Unknown role '${role}'`, role);
  }

  const tierNames = Object.keys(config.models);
  const explicit = explicitDirective(task, "tier", tierNames);
  if (explicit) {
    if (!roleConfig.allowedTiers.includes(explicit)) {
      throw new RoutingError(
        "unsupported-role-tier",
        `Tier '${explicit}' is not allowed for role '${role}'`,
        role,
        explicit,
      );
    }
    return explicit;
  }

  const text = classificationText(task);
  const modeTier = config.activeMode ? config.modes?.[config.activeMode]?.defaultTier : undefined;
  const candidate = matchedTier(text, config) ?? modeTier ?? roleConfig.defaultTier;
  if (!config.models[candidate]) {
    throw new RoutingError("unknown-tier", `Unknown tier '${candidate}'`, role, candidate);
  }
  if (roleConfig.allowedTiers.includes(candidate)) return candidate;
  return adjustAutomaticTier(candidate, role, roleConfig.allowedTiers, config);
}

export function resolveAgentIdentity(
  task: string,
  config: Readonly<NormalizedRouterConfig>,
): AgentIdentity {
  const role = classifyTaskRole(task, config);
  const tier = selectModelTier(task, role, config);
  return { role, tier, agentName: `${role}-${tier}` };
}
