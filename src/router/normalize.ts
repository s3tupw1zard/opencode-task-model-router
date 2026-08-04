import type {
  EnforcementConfig,
  FallbackConfig,
  ModeConfig,
  Preset,
  RouterConfig,
  TierConfig,
} from "./config";

export type ConfigSchemaVersion = 1 | 2;
export type ToolCategory =
  | "memoryWrite"
  | "externalWrite"
  | "codeMutation"
  | "commandExecution"
  | "externalResearch"
  | "memoryRead"
  | "localRead";
export type BudgetCategory = ToolCategory | "totalCalls";

export interface RawConfigV1 {
  schemaVersion?: 1;
  activePreset?: unknown;
  activeMode?: unknown;
  presets?: unknown;
  rules?: unknown;
  defaultTier?: unknown;
  fallback?: unknown;
  taskPatterns?: unknown;
  modes?: unknown;
  tierPrompts?: unknown;
  tierCaps?: unknown;
  enforcement?: unknown;
  experimental?: unknown;
  [key: string]: unknown;
}

export interface RawConfigV2 {
  schemaVersion?: 2;
  activePreset?: unknown;
  activeMode?: unknown;
  defaultRole?: unknown;
  defaultTier?: unknown;
  models?: unknown;
  presets?: unknown;
  roles?: unknown;
  modes?: unknown;
  tools?: unknown;
  budgets?: unknown;
  delegation?: unknown;
  rules?: unknown;
  fallback?: unknown;
  enforcement?: unknown;
  experimental?: unknown;
  compatibility?: unknown;
  [key: string]: unknown;
}

export interface ModelTierOverride {
  model?: string;
  variant?: string;
  thinking?: TierConfig["thinking"];
  reasoning?: TierConfig["reasoning"];
  costRatio?: number;
  color?: string;
  description?: string;
  steps?: number;
  prompt?: string;
  whenToUse?: string[];
}

export interface RoleToolPolicy {
  allowCategories: ToolCategory[];
  denyCategories: ToolCategory[];
  allowMcp: string[];
  denyMcp: string[];
  allowPatterns: string[];
  denyPatterns: string[];
  allowCommands: string[];
  denyCommands: string[];
}

export interface NormalizedRoleConfig {
  description: string;
  prompt: string;
  returnProtocol: string;
  defaultTier: string;
  allowedTiers: string[];
  taskPatterns: string[];
  modelOverrides: Record<string, ModelTierOverride>;
  tools: RoleToolPolicy;
}

export interface McpToolConfig {
  readPatterns: string[];
  writePatterns: string[];
  readCategory: "externalResearch" | "memoryRead" | "localRead";
  writeCategory: "externalWrite" | "memoryWrite";
}

export interface NormalizedToolsConfig {
  categories: Record<ToolCategory, string[]>;
  mcp: Record<string, McpToolConfig>;
}

export type BudgetLimits = Partial<Record<BudgetCategory, number>>;

export interface NormalizedBudgetsConfig {
  global: BudgetLimits;
  roles: Record<string, BudgetLimits>;
  tiers: Record<string, BudgetLimits>;
  roleTiers: Record<string, Record<string, BudgetLimits>>;
}

export interface NormalizedDelegationConfig {
  maxDepth: number;
  allowedChildren: Record<string, string[]>;
}

export function formatAgentName(role: string, tier: string): string {
  return `${role}-${tier}`;
}

export interface AgentIdentity {
  role: string;
  tier: string;
  agentName: string;
}

export type AliasSource = "synthetic-legacy" | "configured";

export interface AliasEntry extends AgentIdentity {
  source: AliasSource;
}

export interface ConfigWarning {
  code:
    | "implicit-schema-v1"
    | "implicit-schema-v2"
    | "legacy-config"
    | "legacy-tier-alias"
    | "legacy-tier-prompt-role-coupling"
    | "legacy-tier-cap-expanded"
    | "persisted-state-ignored";
  message: string;
  source: string;
  path: string;
  canonicalPath?: string;
}

export interface CompatibilityMetadata {
  sourceSchemas: ConfigSchemaVersion[];
  legacyInput: boolean;
  legacyAliasesEnabled: boolean;
  aliases: Record<string, AliasEntry>;
  warnings: readonly ConfigWarning[];
}

export interface NormalizedRouterConfig extends RouterConfig {
  schemaVersion: 2;
  defaultRole: string;
  models: Record<string, TierConfig>;
  roles: Record<string, NormalizedRoleConfig>;
  tools: NormalizedToolsConfig;
  budgets: NormalizedBudgetsConfig;
  delegation: NormalizedDelegationConfig;
  compatibility: CompatibilityMetadata;
}

export interface NormalizedConfigPatch {
  patch: Record<string, unknown>;
  schema: ConfigSchemaVersion;
  warnings: ConfigWarning[];
}

export class ConfigValidationError extends Error {
  constructor(
    public readonly fieldPath: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

const TOOL_CATEGORIES: readonly ToolCategory[] = [
  "memoryWrite",
  "externalWrite",
  "codeMutation",
  "commandExecution",
  "externalResearch",
  "memoryRead",
  "localRead",
];
const BUDGET_CATEGORIES: readonly BudgetCategory[] = [
  ...TOOL_CATEGORIES,
  "totalCalls",
];

const DEFAULT_ROLE_TOOLS: RoleToolPolicy = {
  allowCategories: [],
  denyCategories: ["codeMutation", "externalWrite", "memoryWrite"],
  allowMcp: [],
  denyMcp: [],
  allowPatterns: [],
  denyPatterns: [],
  allowCommands: [],
  denyCommands: [],
};

const DEFAULT_ROLES: Record<string, NormalizedRoleConfig> = {
  explore: {
    description: "Inspect the local codebase without modifying it",
    prompt: "Explore the local codebase and return concise evidence.",
    returnProtocol: "Return findings with file and line references.",
    defaultTier: "fast",
    allowedTiers: ["fast", "medium"],
    taskPatterns: ["find", "locate", "inspect", "trace"],
    modelOverrides: {},
    tools: {
      ...DEFAULT_ROLE_TOOLS,
      allowCategories: ["localRead", "memoryRead"],
    },
  },
  research: {
    description: "Research documentation, web sources, and external repositories",
    prompt: "Research external sources and cite the evidence used.",
    returnProtocol: "Return sources, findings, and unresolved questions.",
    defaultTier: "fast",
    allowedTiers: ["fast", "medium"],
    taskPatterns: ["research", "documentation", "web", "external repository"],
    modelOverrides: {},
    tools: {
      ...DEFAULT_ROLE_TOOLS,
      allowCategories: ["externalResearch", "memoryRead"],
      allowMcp: ["searxng", "context", "github", "time", "memory"],
    },
  },
  implementation: {
    description: "Modify code and run implementation verification",
    prompt: "Implement the requested change and verify the affected behavior.",
    returnProtocol: "Return changed files, decisions, and verification results.",
    defaultTier: "medium",
    allowedTiers: ["fast", "medium", "heavy"],
    taskPatterns: ["implement", "edit", "refactor", "fix", "test"],
    modelOverrides: {},
    tools: {
      ...DEFAULT_ROLE_TOOLS,
      allowCategories: ["localRead", "codeMutation", "commandExecution"],
      denyCategories: ["externalWrite", "memoryWrite"],
    },
  },
  architecture: {
    description: "Plan systems and perform difficult technical analysis",
    prompt: "Analyze architecture, constraints, risks, and tradeoffs.",
    returnProtocol: "Return options, tradeoffs, and a recommendation.",
    defaultTier: "medium",
    allowedTiers: ["medium", "heavy"],
    taskPatterns: ["architecture", "design", "tradeoff", "root cause"],
    modelOverrides: {},
    tools: {
      ...DEFAULT_ROLE_TOOLS,
      allowCategories: ["localRead", "externalResearch", "memoryRead"],
      allowMcp: ["context", "github", "memory", "searxng"],
    },
  },
  review: {
    description: "Independently inspect changes and report risks",
    prompt: "Review changes independently and prioritize concrete findings.",
    returnProtocol: "Return findings ordered by severity.",
    defaultTier: "medium",
    allowedTiers: ["medium", "heavy"],
    taskPatterns: ["review", "audit", "regression", "risk"],
    modelOverrides: {},
    tools: {
      ...DEFAULT_ROLE_TOOLS,
      allowCategories: ["localRead", "commandExecution", "externalResearch"],
      allowMcp: ["github"],
    },
  },
};

const DEFAULT_TOOLS: NormalizedToolsConfig = {
  categories: {
    memoryWrite: [],
    externalWrite: [],
    codeMutation: ["edit", "write", "apply_patch", "patch", "multiedit"],
    commandExecution: ["bash", "shell"],
    externalResearch: ["webfetch", "websearch"],
    memoryRead: [],
    localRead: ["read", "grep", "glob", "list", "ls", "lsp"],
  },
  mcp: {
    searxng: {
      readPatterns: ["searxng_*"],
      writePatterns: [],
      readCategory: "externalResearch",
      writeCategory: "externalWrite",
    },
    context: {
      readPatterns: ["context_*"],
      writePatterns: [],
      readCategory: "externalResearch",
      writeCategory: "externalWrite",
    },
    memory: {
      readPatterns: ["memory_read_*", "memory_search_*", "memory_open_*"],
      writePatterns: ["memory_create_*", "memory_add_*", "memory_delete_*"],
      readCategory: "memoryRead",
      writeCategory: "memoryWrite",
    },
    github: {
      readPatterns: [
        "github_get_*",
        "github_list_*",
        "github_search_*",
        "github_issue_read",
        "github_pull_request_read",
      ],
      writePatterns: [
        "github_create_*",
        "github_update_*",
        "github_delete_*",
        "github_add_*",
        "github_push_*",
        "github_merge_*",
        "github_issue_write",
        "github_sub_issue_write",
        "github_pull_request_review_write",
      ],
      readCategory: "externalResearch",
      writeCategory: "externalWrite",
    },
    time: {
      readPatterns: ["time_*"],
      writePatterns: [],
      readCategory: "externalResearch",
      writeCategory: "externalWrite",
    },
  },
};

const DEFAULT_ROLE_BUDGETS: Record<string, BudgetLimits> = {
  explore: { localRead: 8 },
  research: { externalResearch: 8 },
  implementation: { localRead: 5, commandExecution: 10 },
  architecture: { localRead: 5, externalResearch: 5 },
  review: { localRead: 8, commandExecution: 8 },
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
    ) as T;
  }
  return value;
}

function mergeObjects<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) return cloneValue(override) as T;
  const result: Record<string, unknown> = cloneValue(base);
  for (const [key, value] of Object.entries(override)) {
    result[key] = Object.hasOwn(result, key)
      ? mergeObjects(result[key], value)
      : cloneValue(value);
  }
  return result as T;
}

function fail(path: string, message: string): never {
  throw new ConfigValidationError(path, `tiers.json: '${path}' ${message}`);
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(path, "must be an array of strings");
  }
  if (value.some((item) => !item.trim())) fail(path, "must not contain empty strings");
  return value as string[];
}

function objectValue(value: unknown, path: string): Record<string, unknown> {
  if (!isPlainObject(value)) fail(path, "must be an object");
  return value;
}

function detectSchema(raw: Record<string, unknown>): ConfigSchemaVersion {
  const version = raw.schemaVersion;
  if (version !== undefined) {
    if (version !== 1 && version !== 2) {
      fail("schemaVersion", "must be 1 or 2");
    }
    return version;
  }
  return ["defaultRole", "models", "roles", "tools", "budgets", "delegation"].some((key) =>
    Object.hasOwn(raw, key),
  )
    ? 2
    : 1;
}

export function normalizeConfigPatch(
  raw: unknown,
  source: string,
  bundled = false,
): NormalizedConfigPatch {
  const input = objectValue(raw, "$" );
  const schema = detectSchema(input);
  const explicitSchema = input.schemaVersion !== undefined;
  const patch = cloneValue(input);
  delete patch.schemaVersion;
  const warnings: ConfigWarning[] = [];

  if (!explicitSchema && !bundled) {
    warnings.push({
      code: schema === 1 ? "implicit-schema-v1" : "implicit-schema-v2",
      message: `Configuration schema inferred as v${schema}`,
      source,
      path: "schemaVersion",
    });
  }

  if (schema === 1) {
    if (!bundled) {
      warnings.push({
        code: "legacy-config",
        message: "Legacy v1 configuration was normalized to the canonical schema",
        source,
        path: "$",
      });
    }
    if (isPlainObject(input.tierCaps)) {
      const tiers: Record<string, unknown> = {};
      for (const [tier, cap] of Object.entries(input.tierCaps)) {
        tiers[tier] = { localRead: cloneValue(cap) };
      }
      patch.budgets = patch.budgets === undefined
        ? { tiers }
        : mergeObjects({ tiers }, patch.budgets);
      warnings.push({
        code: "legacy-tier-cap-expanded",
        message: "Legacy tier caps are also exposed as canonical local-read budgets",
        source,
        path: "tierCaps",
        canonicalPath: "budgets.tiers",
      });
    }
    if (isPlainObject(input.tierPrompts)) {
      warnings.push({
        code: "legacy-tier-prompt-role-coupling",
        message: "Legacy tier prompts remain scoped to compatibility agents",
        source,
        path: "tierPrompts",
      });
    }
  }

  return { patch, schema, warnings };
}

function normalizeTier(
  raw: unknown,
  path: string,
  base?: Partial<TierConfig>,
  requireQualifiedModel = true,
): TierConfig {
  const value = objectValue(raw, path);
  const merged = { ...(base ?? {}), ...value } as Record<string, unknown>;
  if (typeof merged.model !== "string" || !merged.model.trim()) {
    fail(`${path}.model`, "must be a non-empty string");
  }
  if (
    requireQualifiedModel &&
    (!merged.model.includes("/") || merged.model.startsWith("/") || merged.model.endsWith("/"))
  ) {
    fail(`${path}.model`, "must use provider/model-id format");
  }
  if (merged.description === undefined) merged.description = `${path.split(".").at(-1)} model tier`;
  if (typeof merged.description !== "string") fail(`${path}.description`, "must be a string");
  if (merged.whenToUse === undefined) merged.whenToUse = [];
  stringArray(merged.whenToUse, `${path}.whenToUse`);
  if (
    merged.costRatio !== undefined &&
    (typeof merged.costRatio !== "number" || !Number.isFinite(merged.costRatio) || merged.costRatio <= 0)
  ) {
    fail(`${path}.costRatio`, "must be a finite number greater than zero");
  }
  if (
    merged.steps !== undefined &&
    (typeof merged.steps !== "number" || !Number.isInteger(merged.steps) || merged.steps < 1)
  ) {
    fail(`${path}.steps`, "must be a positive integer");
  }
  if (merged.prompt !== undefined && typeof merged.prompt !== "string") {
    fail(`${path}.prompt`, "must be a string");
  }
  if (merged.variant !== undefined && typeof merged.variant !== "string") {
    fail(`${path}.variant`, "must be a string");
  }
  if (merged.color !== undefined && typeof merged.color !== "string") {
    fail(`${path}.color`, "must be a string");
  }
  if (merged.thinking !== undefined) {
    if (!isPlainObject(merged.thinking)) fail(`${path}.thinking`, "must be an object");
    const thinking = merged.thinking as Record<string, unknown>;
    if (thinking.budgetTokens !== undefined) {
      if (
        typeof thinking.budgetTokens !== "number" ||
        !Number.isInteger(thinking.budgetTokens) ||
        thinking.budgetTokens < 1
      ) {
        fail(`${path}.thinking.budgetTokens`, "must be a positive integer");
      }
    }
  }
  if (merged.reasoning !== undefined) {
    if (!isPlainObject(merged.reasoning)) fail(`${path}.reasoning`, "must be an object");
    const reasoning = merged.reasoning as Record<string, unknown>;
    if (reasoning.effort !== undefined && typeof reasoning.effort !== "string") {
      fail(`${path}.reasoning.effort`, "must be a string");
    }
    if (reasoning.summary !== undefined && typeof reasoning.summary !== "string") {
      fail(`${path}.reasoning.summary`, "must be a string");
    }
  }
  return merged as unknown as TierConfig;
}

function normalizePresets(
  rawModels: unknown,
  rawPresets: unknown,
  activePreset: string,
  requireQualifiedModels: boolean,
): { models: Record<string, TierConfig>; presets: Record<string, Preset> } {
  const hasExplicitModels = rawModels !== undefined;
  const modelInput = rawModels === undefined ? {} : objectValue(rawModels, "models");
  const presetInput = rawPresets === undefined ? {} : objectValue(rawPresets, "presets");
  let models: Record<string, TierConfig> = {};

  for (const [tier, value] of Object.entries(modelInput)) {
    models[tier] = normalizeTier(value, `models.${tier}`, undefined, requireQualifiedModels);
  }

  const activeRaw = presetInput[activePreset];
  if (Object.keys(models).length === 0 && isPlainObject(activeRaw)) {
    for (const [tier, value] of Object.entries(activeRaw)) {
      models[tier] = normalizeTier(
        value,
        `presets.${activePreset}.${tier}`,
        undefined,
        requireQualifiedModels,
      );
    }
  }
  if (Object.keys(models).length === 0) fail("models", "must define at least one model tier");

  const presets: Record<string, Preset> = {};
  for (const [presetName, rawPreset] of Object.entries(presetInput)) {
    const preset = objectValue(rawPreset, `presets.${presetName}`);
    if (hasExplicitModels) {
      for (const tier of Object.keys(preset)) {
        if (!models[tier]) {
          fail(
            `presets.${presetName}.${tier}`,
            "references a tier missing from top-level models",
          );
        }
      }
    }
    const resolved: Preset = {};
    const tierNames = new Set(
      hasExplicitModels
        ? [...Object.keys(models), ...Object.keys(preset)]
        : Object.keys(preset),
    );
    for (const tier of tierNames) {
      const override = preset[tier];
      if (override === undefined) {
        resolved[tier] = cloneValue(models[tier]!);
      } else {
        resolved[tier] = normalizeTier(
          override,
          `presets.${presetName}.${tier}`,
          hasExplicitModels ? models[tier] : undefined,
          requireQualifiedModels,
        );
      }
    }
    presets[presetName] = resolved;
  }
  if (!presets[activePreset]) presets[activePreset] = cloneValue(models);
  return { models, presets };
}

function normalizeRoleTools(raw: unknown, path: string): RoleToolPolicy {
  const value = objectValue(raw, path);
  const result = mergeObjects(DEFAULT_ROLE_TOOLS, value);
  for (const key of [
    "allowCategories",
    "denyCategories",
    "allowMcp",
    "denyMcp",
    "allowPatterns",
    "denyPatterns",
    "allowCommands",
    "denyCommands",
  ] as const) {
    result[key] = stringArray(result[key], `${path}.${key}`) as never;
  }
  for (const [allowKey, denyKey] of [
    ["allowCategories", "denyCategories"],
    ["allowMcp", "denyMcp"],
    ["allowPatterns", "denyPatterns"],
    ["allowCommands", "denyCommands"],
  ] as const) {
    const denied = new Set(result[denyKey]);
    const conflict = result[allowKey].find((value) => denied.has(value));
    if (conflict) fail(path, `must not both allow and deny '${conflict}'`);
  }
  return result;
}

function normalizeRoles(
  raw: unknown,
  models: Readonly<Record<string, TierConfig>>,
  requireQualifiedModels: boolean,
): Record<string, NormalizedRoleConfig> {
  const tierNames = Object.keys(models);
  const input = raw === undefined ? {} : objectValue(raw, "roles");
  const merged = mergeObjects(DEFAULT_ROLES, input);
  const roles: Record<string, NormalizedRoleConfig> = {};
  for (const [name, rawRole] of Object.entries(merged)) {
    const path = `roles.${name}`;
    const role = objectValue(rawRole, path);
    const explicitRole = isPlainObject(input[name]) ? input[name] : {};
    if (!Object.hasOwn(explicitRole, "allowedTiers")) {
      const configured = new Set(tierNames);
      const compatible = (role.allowedTiers as string[]).filter((tier) => configured.has(tier));
      role.allowedTiers = compatible.length > 0 ? compatible : [tierNames[0]];
    }
    if (
      !Object.hasOwn(explicitRole, "defaultTier") &&
      (role.allowedTiers as string[]).length > 0 &&
      !(role.allowedTiers as string[]).includes(role.defaultTier as string)
    ) {
      role.defaultTier = (role.allowedTiers as string[])[0];
    }
    if (typeof role.description !== "string") fail(`${path}.description`, "must be a string");
    if (typeof role.prompt !== "string") fail(`${path}.prompt`, "must be a string");
    if (typeof role.returnProtocol !== "string") fail(`${path}.returnProtocol`, "must be a string");
    if (typeof role.defaultTier !== "string" || !role.defaultTier) {
      fail(`${path}.defaultTier`, "must be a non-empty string");
    }
    const allowedTiers = stringArray(role.allowedTiers, `${path}.allowedTiers`);
    if (allowedTiers.length === 0) fail(`${path}.allowedTiers`, "must not be empty");
    if (new Set(allowedTiers).size !== allowedTiers.length) {
      fail(`${path}.allowedTiers`, "must not contain duplicates");
    }
    const taskPatterns = stringArray(role.taskPatterns, `${path}.taskPatterns`);
    const modelOverrides = role.modelOverrides === undefined
      ? {}
      : objectValue(role.modelOverrides, `${path}.modelOverrides`);
    for (const [tier, override] of Object.entries(modelOverrides)) {
      if (models[tier]) {
        normalizeTier(
          override,
          `${path}.modelOverrides.${tier}`,
          models[tier],
          requireQualifiedModels,
        );
      } else {
        objectValue(override, `${path}.modelOverrides.${tier}`);
      }
    }
    roles[name] = {
      description: role.description,
      prompt: role.prompt,
      returnProtocol: role.returnProtocol,
      defaultTier: role.defaultTier,
      allowedTiers,
      taskPatterns,
      modelOverrides: modelOverrides as Record<string, ModelTierOverride>,
      tools: normalizeRoleTools(role.tools ?? {}, `${path}.tools`),
    };
  }
  return roles;
}

function normalizeModes(raw: unknown): Record<string, ModeConfig> {
  const input = raw === undefined ? {} : objectValue(raw, "modes");
  const modes: Record<string, ModeConfig> = {};
  for (const [name, rawMode] of Object.entries(input)) {
    const path = `modes.${name}`;
    const mode = objectValue(rawMode, path);
    if (typeof mode.defaultTier !== "string" || !mode.defaultTier) {
      fail(`${path}.defaultTier`, "must be a non-empty string");
    }
    if (typeof mode.description !== "string") {
      fail(`${path}.description`, "must be a string");
    }
    modes[name] = {
      defaultTier: mode.defaultTier,
      description: mode.description,
      ...(mode.overrideRules === undefined
        ? {}
        : { overrideRules: stringArray(mode.overrideRules, `${path}.overrideRules`) }),
    };
  }
  return modes;
}

function normalizeFallback(raw: unknown): FallbackConfig | undefined {
  if (raw === undefined) return undefined;
  const input = objectValue(raw, "fallback");
  const result: FallbackConfig = {};
  if (input.global !== undefined) {
    const global = objectValue(input.global, "fallback.global");
    result.global = Object.fromEntries(
      Object.entries(global).map(([preset, chain]) => [
        preset,
        stringArray(chain, `fallback.global.${preset}`),
      ]),
    );
  }
  if (input.presets !== undefined) {
    const presets = objectValue(input.presets, "fallback.presets");
    result.presets = {};
    for (const [preset, rawTiers] of Object.entries(presets)) {
      const tiers = objectValue(rawTiers, `fallback.presets.${preset}`);
      result.presets[preset] = Object.fromEntries(
        Object.entries(tiers).map(([tier, chain]) => [
          tier,
          stringArray(chain, `fallback.presets.${preset}.${tier}`),
        ]),
      );
    }
  }
  return result;
}

function normalizeExperimental(raw: unknown): RouterConfig["experimental"] {
  if (raw === undefined) return undefined;
  const input = objectValue(raw, "experimental");
  if (
    input.verifiedDelegateTool !== undefined &&
    typeof input.verifiedDelegateTool !== "boolean"
  ) {
    fail("experimental.verifiedDelegateTool", "must be a boolean");
  }
  return input as RouterConfig["experimental"];
}

function normalizeTools(raw: unknown): NormalizedToolsConfig {
  const value = raw === undefined ? {} : objectValue(raw, "tools");
  const merged = mergeObjects(DEFAULT_TOOLS, value);
  const categories = objectValue(merged.categories, "tools.categories");
  for (const key of Object.keys(categories)) {
    if (!TOOL_CATEGORIES.includes(key as ToolCategory)) {
      fail(`tools.categories.${key}`, "is not a supported tool category");
    }
    categories[key] = stringArray(categories[key], `tools.categories.${key}`);
  }
  const mcpInput = objectValue(merged.mcp, "tools.mcp");
  const mcp: Record<string, McpToolConfig> = {};
  for (const [name, rawMcp] of Object.entries(mcpInput)) {
    const path = `tools.mcp.${name}`;
    const entry = objectValue(rawMcp, path);
    const readPatterns = stringArray(entry.readPatterns ?? [], `${path}.readPatterns`);
    const writePatterns = stringArray(entry.writePatterns ?? [], `${path}.writePatterns`);
    if (readPatterns.length === 0 && writePatterns.length === 0) {
      fail(path, "must define at least one read or write pattern");
    }
    const readCategory = entry.readCategory ?? "externalResearch";
    const writeCategory = entry.writeCategory ?? "externalWrite";
    if (!["externalResearch", "memoryRead", "localRead"].includes(readCategory as string)) {
      fail(`${path}.readCategory`, "must be externalResearch, memoryRead, or localRead");
    }
    if (!["externalWrite", "memoryWrite"].includes(writeCategory as string)) {
      fail(`${path}.writeCategory`, "must be externalWrite or memoryWrite");
    }
    const writeSet = new Set(writePatterns);
    if (readPatterns.some((pattern) => writeSet.has(pattern))) {
      fail(path, "must not assign the same pattern to reads and writes");
    }
    mcp[name] = {
      readPatterns,
      writePatterns,
      readCategory: readCategory as McpToolConfig["readCategory"],
      writeCategory: writeCategory as McpToolConfig["writeCategory"],
    };
  }
  return { categories: categories as Record<ToolCategory, string[]>, mcp };
}

function validateBudgetLimits(raw: unknown, path: string): BudgetLimits {
  const value = objectValue(raw, path);
  const result: BudgetLimits = {};
  for (const [category, limit] of Object.entries(value)) {
    if (!BUDGET_CATEGORIES.includes(category as BudgetCategory)) {
      fail(`${path}.${category}`, "is not a supported budget category");
    }
    if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 0) {
      fail(`${path}.${category}`, "must be an integer greater than or equal to zero");
    }
    result[category as BudgetCategory] = limit;
  }
  return result;
}

function normalizeBudgets(raw: unknown): NormalizedBudgetsConfig {
  const defaults: NormalizedBudgetsConfig = {
    global: {},
    roles: DEFAULT_ROLE_BUDGETS,
    tiers: {},
    roleTiers: {},
  };
  const merged = mergeObjects(defaults, raw ?? {});
  const global = validateBudgetLimits(merged.global, "budgets.global");
  const rolesInput = objectValue(merged.roles, "budgets.roles");
  const tiersInput = objectValue(merged.tiers, "budgets.tiers");
  const roleTiersInput = objectValue(merged.roleTiers, "budgets.roleTiers");
  const roles: Record<string, BudgetLimits> = {};
  const tiers: Record<string, BudgetLimits> = {};
  const roleTiers: Record<string, Record<string, BudgetLimits>> = {};
  for (const [role, limits] of Object.entries(rolesInput)) {
    roles[role] = validateBudgetLimits(limits, `budgets.roles.${role}`);
  }
  for (const [tier, limits] of Object.entries(tiersInput)) {
    tiers[tier] = validateBudgetLimits(limits, `budgets.tiers.${tier}`);
  }
  for (const [role, rawTiers] of Object.entries(roleTiersInput)) {
    roleTiers[role] = {};
    for (const [tier, limits] of Object.entries(objectValue(rawTiers, `budgets.roleTiers.${role}`))) {
      roleTiers[role]![tier] = validateBudgetLimits(
        limits,
        `budgets.roleTiers.${role}.${tier}`,
      );
    }
  }
  return { global, roles, tiers, roleTiers };
}

function normalizeDelegation(
  raw: unknown,
  roleNames: readonly string[],
): NormalizedDelegationConfig {
  const defaultChildren = Object.fromEntries(roleNames.map((role) => [role, []]));
  const value = mergeObjects(
    { maxDepth: 1, allowedChildren: defaultChildren },
    raw ?? {},
  );
  if (typeof value.maxDepth !== "number" || !Number.isInteger(value.maxDepth) || value.maxDepth < 1) {
    fail("delegation.maxDepth", "must be an integer greater than or equal to one");
  }
  const input = objectValue(value.allowedChildren, "delegation.allowedChildren");
  const allowedChildren: Record<string, string[]> = {};
  for (const [role, children] of Object.entries(input)) {
    const values = stringArray(children, `delegation.allowedChildren.${role}`);
    if (new Set(values).size !== values.length) {
      fail(`delegation.allowedChildren.${role}`, "must not contain duplicates");
    }
    allowedChildren[role] = values;
  }
  return { maxDepth: value.maxDepth, allowedChildren };
}

function validateCanonicalName(name: string, kind: string, path: string): void {
  if (!name || !name.trim()) fail(path, `${kind} must not be empty`);
  if (name !== name.trim()) fail(path, `${kind} must not have leading or trailing whitespace`);
}

function validateNames(
  names: readonly string[],
  kind: string,
  basePath: string,
): void {
  const seenExact = new Set<string>();
  const seenLower = new Map<string, string>();
  for (const name of names) {
    if (seenExact.has(name)) fail(basePath, `${kind} '${name}' is duplicated`);
    seenExact.add(name);
    const lower = name.toLowerCase();
    const previous = seenLower.get(lower);
    if (previous && previous !== name) {
      fail(basePath, `${kind} '${name}' collides case-insensitively with '${previous}'`);
    }
    seenLower.set(lower, name);
  }
}

function validateReferences(
  config: NormalizedRouterConfig,
  strictCanonical: boolean,
): void {
  const tierNames = Object.keys(config.models);
  const roleNames = Object.keys(config.roles);
  for (const name of tierNames) validateCanonicalName(name, "tier", `models.${name}`);
  for (const name of roleNames) validateCanonicalName(name, "role", `roles.${name}`);
  validateNames(tierNames, "tier", "models");
  validateNames(roleNames, "role", "roles");

  const canonicalNames = new Set<string>();
  const canonicalLower = new Map<string, string>();
  for (const role of roleNames) {
    for (const tier of config.roles[role]!.allowedTiers) {
      const name = formatAgentName(role, tier);
      if (canonicalNames.has(name)) {
        fail(`roles.${role}.allowedTiers`, `generated agent name '${name}' collides with another role-tier combination`);
      }
      canonicalNames.add(name);
      const lower = name.toLowerCase();
      const previous = canonicalLower.get(lower);
      if (previous && previous !== name) {
        fail(`roles.${role}.allowedTiers`, `generated agent name '${name}' collides case-insensitively with '${previous}'`);
      }
      canonicalLower.set(lower, name);
    }
  }

  const tiers = new Set(tierNames);
  if (!tiers.has(config.defaultTier)) fail("defaultTier", "must reference a configured tier");
  for (const tier of Object.keys(config.taskPatterns ?? {})) {
    if (strictCanonical && !tiers.has(tier)) {
      fail(`taskPatterns.${tier}`, "references an unknown tier");
    }
  }
  if (config.activeMode && !config.modes?.[config.activeMode]) {
    fail("activeMode", "must reference a configured mode");
  }
  for (const [mode, value] of Object.entries(config.modes ?? {})) {
    if (strictCanonical && !tiers.has(value.defaultTier)) {
      fail(`modes.${mode}.defaultTier`, "must reference a configured tier");
    }
  }
  const roles = new Set(Object.keys(config.roles));
  if (!roles.has(config.defaultRole)) {
    fail("defaultRole", "must reference a configured role");
  }
  const mcpNames = new Set(Object.keys(config.tools.mcp));
  for (const [roleName, role] of Object.entries(config.roles)) {
    for (const tier of role.allowedTiers) {
      if (!tiers.has(tier)) fail(`roles.${roleName}.allowedTiers`, `references missing tier '${tier}'`);
    }
    if (!role.allowedTiers.includes(role.defaultTier)) {
      fail(`roles.${roleName}.defaultTier`, "must be included in allowedTiers");
    }
    for (const tier of Object.keys(role.modelOverrides)) {
      if (!tiers.has(tier)) fail(`roles.${roleName}.modelOverrides.${tier}`, "references a missing tier");
      if (!role.allowedTiers.includes(tier)) {
        fail(`roles.${roleName}.modelOverrides.${tier}`, "references a tier not allowed for the role");
      }
    }
    for (const category of [...role.tools.allowCategories, ...role.tools.denyCategories]) {
      if (!TOOL_CATEGORIES.includes(category)) {
        fail(`roles.${roleName}.tools`, `references unknown category '${category}'`);
      }
    }
    for (const mcp of [...role.tools.allowMcp, ...role.tools.denyMcp]) {
      if (!mcpNames.has(mcp)) fail(`roles.${roleName}.tools`, `references unknown MCP '${mcp}'`);
    }
  }
  for (const role of Object.keys(config.budgets.roles)) {
    if (!roles.has(role)) fail(`budgets.roles.${role}`, "references an unknown role");
  }
  for (const tier of Object.keys(config.budgets.tiers)) {
    if (strictCanonical && !tiers.has(tier)) {
      fail(`budgets.tiers.${tier}`, "references an unknown tier");
    }
  }
  for (const [role, roleTiers] of Object.entries(config.budgets.roleTiers)) {
    if (!roles.has(role)) fail(`budgets.roleTiers.${role}`, "references an unknown role");
    for (const tier of Object.keys(roleTiers)) {
      if (strictCanonical && !tiers.has(tier)) {
        fail(`budgets.roleTiers.${role}.${tier}`, "references an unknown tier");
      }
    }
  }
  for (const [role, children] of Object.entries(config.delegation.allowedChildren)) {
    if (!roles.has(role)) fail(`delegation.allowedChildren.${role}`, "references an unknown role");
    for (const child of children) {
      if (!roles.has(child)) fail(`delegation.allowedChildren.${role}`, `references unknown role '${child}'`);
      if (child === role) fail(`delegation.allowedChildren.${role}`, "must not contain self-delegation");
      if (
        strictCanonical &&
        (role !== "implementation" || !["explore", "research"].includes(child))
      ) {
        fail(
          `delegation.allowedChildren.${role}`,
          `does not allow delegation from '${role}' to '${child}'`,
        );
      }
    }
  }
  const escalate = config.enforcement?.escalate;
  if (strictCanonical && Array.isArray(escalate?.ladder)) {
    if (escalate.ladder.length === 0) fail("enforcement.escalate.ladder", "must not be empty");
    if (new Set(escalate.ladder).size !== escalate.ladder.length) {
      fail("enforcement.escalate.ladder", "must not contain duplicates");
    }
    for (const tier of escalate.ladder) {
      if (!tiers.has(tier)) fail("enforcement.escalate.ladder", `references missing tier '${tier}'`);
    }
    if (escalate.floorTier && !escalate.ladder.includes(escalate.floorTier)) {
      fail("enforcement.escalate.floorTier", "must appear in the escalation ladder");
    }
  }
  const minGraderTier = config.enforcement?.verify?.minGraderTier;
  if (strictCanonical && minGraderTier && !tiers.has(minGraderTier)) {
    fail("enforcement.verify.minGraderTier", "must reference a configured tier");
  }
  for (const tier of Object.keys(config.enforcement?.perTier ?? {})) {
    if (strictCanonical && !tiers.has(tier)) {
      fail(`enforcement.perTier.${tier}`, "references an unknown tier");
    }
  }
  for (const [alias, identity] of Object.entries(config.compatibility.aliases)) {
    validateCanonicalName(alias, "alias", `compatibility.aliases.${alias}`);
    if (canonicalNames.has(alias)) {
      fail(`compatibility.aliases.${alias}`, "must not collide with a canonical agent name");
    }
    if (canonicalLower.has(alias.toLowerCase())) {
      fail(`compatibility.aliases.${alias}`, "must not collide case-insensitively with a canonical agent name");
    }
    if (!roles.has(identity.role)) fail(`compatibility.aliases.${alias}.role`, "references an unknown role");
    if (!tiers.has(identity.tier)) fail(`compatibility.aliases.${alias}.tier`, "references an unknown tier");
    if (!config.roles[identity.role]!.allowedTiers.includes(identity.tier)) {
      fail(`compatibility.aliases.${alias}.tier`, "is not allowed for the alias role");
    }
    const expectedName = formatAgentName(identity.role, identity.tier);
    if (identity.agentName !== expectedName) {
      fail(`compatibility.aliases.${alias}`, `agentName '${identity.agentName}' must match canonical target '${expectedName}'`);
    }
  }
  const aliasLower = new Map<string, string>();
  for (const alias of Object.keys(config.compatibility.aliases)) {
    const lower = alias.toLowerCase();
    const previous = aliasLower.get(lower);
    if (previous && previous !== alias) {
      fail(`compatibility.aliases.${alias}`, `case-insensitively collides with alias '${previous}'`);
    }
    aliasLower.set(lower, alias);
  }
}

export function finalizeNormalizedConfig(
  raw: unknown,
  sourceSchemas: ConfigSchemaVersion[],
  warnings: ConfigWarning[],
): NormalizedRouterConfig {
  const input = objectValue(raw, "$" );
  if (typeof input.activePreset !== "string" || !input.activePreset.trim()) {
    fail("activePreset", "must be a non-empty string");
  }
  const activePreset = input.activePreset;
  const strictCanonical = sourceSchemas.includes(2);
  const { models, presets } = normalizePresets(
    input.models,
    input.presets,
    activePreset,
    strictCanonical,
  );
  const roles = normalizeRoles(input.roles, models, strictCanonical);
  const defaultRole = input.defaultRole === undefined ? "implementation" : input.defaultRole;
  if (typeof defaultRole !== "string" || !defaultRole.trim()) {
    fail("defaultRole", "must be a non-empty string");
  }
  const tools = normalizeTools(input.tools);
  const budgets = normalizeBudgets(input.budgets);
  const delegation = normalizeDelegation(input.delegation, Object.keys(roles));
  const defaultTier = typeof input.defaultTier === "string" && input.defaultTier
    ? input.defaultTier
    : models.medium
      ? "medium"
      : Object.keys(models)[0]!;
  const rules = input.rules === undefined ? [] : stringArray(input.rules, "rules");
  const modes = normalizeModes(input.modes);
  const compatibilityInput = isPlainObject(input.compatibility) ? input.compatibility : {};
  if (
    compatibilityInput.legacyAliases !== undefined &&
    typeof compatibilityInput.legacyAliases !== "boolean"
  ) {
    fail("compatibility.legacyAliases", "must be a boolean");
  }
  const legacyAliasesEnabled = compatibilityInput.legacyAliases !== false;
  const aliases: Record<string, AliasEntry> = {};
  if (legacyAliasesEnabled) {
    const candidates: Record<string, AliasEntry> = {
      fast: { role: "explore", tier: "fast", agentName: formatAgentName("explore", "fast"), source: "synthetic-legacy" },
      medium: { role: "implementation", tier: "medium", agentName: formatAgentName("implementation", "medium"), source: "synthetic-legacy" },
      heavy: { role: "architecture", tier: "heavy", agentName: formatAgentName("architecture", "heavy"), source: "synthetic-legacy" },
    };
    for (const [name, identity] of Object.entries(candidates)) {
      if (models[identity.tier] && roles[identity.role]?.allowedTiers.includes(identity.tier)) {
        aliases[name] = identity;
      }
    }
  }
  if (isPlainObject(compatibilityInput.aliases)) {
    for (const [name, rawAlias] of Object.entries(compatibilityInput.aliases)) {
      if (!name.trim()) fail("compatibility.aliases", "must not contain an empty alias name");
      const alias = objectValue(rawAlias, `compatibility.aliases.${name}`);
      if (typeof alias.role !== "string") fail(`compatibility.aliases.${name}.role`, "must be a string");
      if (typeof alias.tier !== "string") fail(`compatibility.aliases.${name}.tier`, "must be a string");
      aliases[name] = {
        role: alias.role,
        tier: alias.tier,
        agentName: typeof alias.agentName === "string" ? alias.agentName : formatAgentName(alias.role, alias.tier),
        source: "configured",
      };
    }
  }
  if (sourceSchemas.includes(1) && Object.keys(aliases).length > 0) {
    const aliasNames = Object.keys(aliases).join(", ");
    warnings.push({
      code: "legacy-tier-alias",
      message: `Legacy aliases were synthesized: ${aliasNames}`,
      source: warnings.find((warning) => warning.code === "legacy-config")?.source ?? "tiers.json",
      path: "$",
      canonicalPath: "compatibility.aliases",
    });
  }

  const config = {
    ...cloneValue(input),
    schemaVersion: 2 as const,
    activePreset,
    activeMode: typeof input.activeMode === "string" ? input.activeMode : undefined,
    defaultRole,
    defaultTier,
    models,
    presets,
    roles,
    tools,
    budgets,
    delegation,
    rules,
    modes,
    fallback: normalizeFallback(input.fallback),
    enforcement: input.enforcement as EnforcementConfig | undefined,
    experimental: normalizeExperimental(input.experimental),
    compatibility: {
      sourceSchemas: [...new Set(sourceSchemas)],
      legacyInput: sourceSchemas.includes(1),
      legacyAliasesEnabled,
      aliases,
      warnings,
    },
  } satisfies NormalizedRouterConfig;
  validateReferences(config, strictCanonical);
  return config;
}
