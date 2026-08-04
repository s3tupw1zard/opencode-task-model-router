import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getNodeValue,
  parseTree,
  printParseErrorCode,
  type Node as JsoncNode,
  type ParseError,
} from "jsonc-parser";
import {
  ConfigValidationError,
  finalizeNormalizedConfig,
  normalizeConfigPatch,
  type ConfigSchemaVersion,
  type ConfigWarning,
  type NormalizedRouterConfig,
} from "./normalize";

export type {
  AgentIdentity,
  AliasEntry,
  AliasSource,
  BudgetCategory,
  BudgetLimits,
  CompatibilityMetadata,
  ConfigSchemaVersion,
  ConfigWarning,
  McpToolConfig,
  ModelTierOverride,
  NormalizedBudgetsConfig,
  NormalizedDelegationConfig,
  NormalizedRoleConfig,
  NormalizedRouterConfig,
  NormalizedToolsConfig,
  RawConfigV1,
  RawConfigV2,
  RoleToolPolicy,
  ToolCategory,
} from "./normalize";
export { formatAgentName } from "./normalize";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ThinkingConfig {
  budgetTokens?: number;
}

export interface ReasoningConfig {
  effort?: "low" | "medium" | "high";
  summary?: "auto" | "always" | "never";
}

export interface TierConfig {
  model: string;
  variant?: string;
  thinking?: ThinkingConfig;
  reasoning?: ReasoningConfig;
  costRatio?: number;
  color?: string;
  description: string;
  steps?: number;
  prompt?: string;
  whenToUse: string[];
}

export type Preset = Record<string, TierConfig>;

export interface FallbackConfig {
  global?: Record<string, string[]>;
  presets?: Record<string, Record<string, string[]>>;
}

export interface ModeConfig {
  defaultTier: string;
  description: string;
  overrideRules?: string[];
}

export interface EnforcementConfig {
  mode?: "off" | "advisory" | "enforced";
  envGate?: string;
  perTier?: Record<string, "off" | "advisory" | "enforced">;
  guard?: { readDraftCap?: number; sameOpRetryCap?: number; blockSelfScript?: boolean; deliverableFirst?: boolean; budget?: number; blockScriptWrites?: boolean };
  verify?: { require?: "never" | "whenDoDPresent" | "always"; requireExplicitDoD?: boolean; preferDeterministic?: boolean; graderPolicy?: "atLeastProducerTier"; graderTemperature?: number; minGraderTier?: string };
  escalate?: { floorTier?: string | null; ladder?: string[]; maxAttemptsPerTier?: number; maxTotalAttempts?: number; costCeiling?: { base?: string; multiple?: number } };
  proportional?: { trivialBypass?: boolean; trivialClassifier?: string };
}

export interface RouterConfig {
  activePreset: string;
  activeMode?: string;
  presets: Record<string, Preset>;
  rules: string[];
  defaultTier: string;
  fallback?: FallbackConfig;
  taskPatterns?: Record<string, string[]>;
  modes?: Record<string, ModeConfig>;
  /** Global default prompts per tier name. A preset-level tier.prompt overrides this. */
  tierPrompts?: Record<string, string>;
  /** Read-only tool-call caps per tier, enforced at runtime via tool.execute.after banner injection. */
  tierCaps?: Record<string, number>;
  enforcement?: EnforcementConfig;
  /** Experimental, opt-in features. Off by default. */
  experimental?: { verifiedDelegateTool?: boolean };
}

export interface RouterState {
  activePreset?: string;
  activeMode?: string;
  enforcementMode?: "off" | "advisory" | "enforced";
}

export const STATE_FILE_NAME = "opencode-task-model-router.state.json";
export const LEGACY_STATE_FILE_NAME = "opencode-model-router.state.json";
export const CONFIG_FILE_NAME = "task-model-router.jsonc";

export type ConfigLayerKind = "bundled" | "global" | "project";

export interface ConfigLayer {
  kind: ConfigLayerKind;
  path: string;
  value: unknown;
}

export interface ConfigLoadOptions {
  projectRoot?: string;
}

export interface LoadedConfig {
  config: NormalizedRouterConfig;
  layers: readonly ConfigLayer[];
  provenance: ReadonlyMap<string, string>;
  canonicalProvenance: ReadonlyMap<string, string>;
  warnings: readonly ConfigWarning[];
}

// ---------------------------------------------------------------------------
// Config loader with caching
// ---------------------------------------------------------------------------

const _configCache = new Map<string, LoadedConfig>();

/** Mark config cache as stale so it is re-read on next access. */
export function invalidateConfigCache(): void {
  _configCache.clear();
}

function getPluginRoot(): string {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const distRoot = join(__dirname, "..");
  if (existsSync(join(distRoot, "tiers.json"))) return distRoot;
  return join(__dirname, "../..");
}

export function configPath(): string {
  return join(getPluginRoot(), "tiers.json");
}

export function globalConfigPath(): string {
  return join(homedir(), ".config", "opencode", CONFIG_FILE_NAME);
}

export function projectConfigPath(projectRoot: string): string {
  return join(resolve(projectRoot), ".opencode", CONFIG_FILE_NAME);
}

export function statePath(): string {
  return join(homedir(), ".config", "opencode", STATE_FILE_NAME);
}

export function legacyStatePath(): string {
  return join(homedir(), ".config", "opencode", LEGACY_STATE_FILE_NAME);
}

export function resolvePresetName(
  cfg: RouterConfig,
  requestedPreset: string,
): string | undefined {
  if (cfg.presets[requestedPreset]) {
    return requestedPreset;
  }

  const normalized = requestedPreset.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }

  return Object.keys(cfg.presets).find(
    (name) => name.toLowerCase() === normalized,
  );
}

function validateLegacyConfig(raw: unknown): RouterConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("tiers.json: expected a JSON object at root");
  }

  const obj = raw as Record<string, unknown>;

  if (typeof obj.activePreset !== "string" || !obj.activePreset) {
    throw new Error("tiers.json: 'activePreset' must be a non-empty string");
  }
  if (
    typeof obj.presets !== "object" ||
    obj.presets === null ||
    Array.isArray(obj.presets)
  ) {
    throw new Error("tiers.json: 'presets' must be a non-null object");
  }

  const presets = obj.presets as Record<string, unknown>;
  for (const [presetName, preset] of Object.entries(presets)) {
    if (
      typeof preset !== "object" ||
      preset === null ||
      Array.isArray(preset)
    ) {
      throw new Error(`tiers.json: preset '${presetName}' must be an object`);
    }
    const tiers = preset as Record<string, unknown>;
    for (const [tierName, tier] of Object.entries(tiers)) {
      if (typeof tier !== "object" || tier === null) {
        throw new Error(
          `tiers.json: tier '${presetName}.${tierName}' must be an object`,
        );
      }
      const t = tier as Record<string, unknown>;
      if (typeof t.model !== "string" || !t.model) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.model' must be a non-empty string`,
        );
      }
      if (typeof t.description !== "string") {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.description' must be a string`,
        );
      }
      if (!Array.isArray(t.whenToUse)) {
        throw new Error(
          `tiers.json: '${presetName}.${tierName}.whenToUse' must be an array`,
        );
      }
    }
  }

  if (!Array.isArray(obj.rules)) {
    throw new Error("tiers.json: 'rules' must be an array of strings");
  }
  if (typeof obj.defaultTier !== "string") {
    throw new Error("tiers.json: 'defaultTier' must be a string");
  }

  // Validate modes if present
  if (obj.modes !== undefined) {
    if (
      typeof obj.modes !== "object" ||
      obj.modes === null ||
      Array.isArray(obj.modes)
    ) {
      throw new Error("tiers.json: 'modes' must be an object");
    }
    const modes = obj.modes as Record<string, unknown>;
    for (const [modeName, mode] of Object.entries(modes)) {
      if (typeof mode !== "object" || mode === null) {
        throw new Error(`tiers.json: mode '${modeName}' must be an object`);
      }
      const m = mode as Record<string, unknown>;
      if (typeof m.defaultTier !== "string") {
        throw new Error(
          `tiers.json: mode '${modeName}.defaultTier' must be a string`,
        );
      }
      if (typeof m.description !== "string") {
        throw new Error(
          `tiers.json: mode '${modeName}.description' must be a string`,
        );
      }
    }
  }

  // Validate tierCaps if present
  if (obj.tierCaps !== undefined) {
    if (
      typeof obj.tierCaps !== "object" ||
      obj.tierCaps === null ||
      Array.isArray(obj.tierCaps)
    ) {
      throw new Error("tiers.json: 'tierCaps' must be an object");
    }
    const tc = obj.tierCaps as Record<string, unknown>;
    for (const [tierName, cap] of Object.entries(tc)) {
      if (typeof cap !== "number" || !Number.isFinite(cap) || cap < 1) {
        throw new Error(
          `tiers.json: tierCaps.'${tierName}' must be a positive integer`,
        );
      }
    }
  }

  // Validate tierPrompts if present
  if (obj.tierPrompts !== undefined) {
    if (
      typeof obj.tierPrompts !== "object" ||
      obj.tierPrompts === null ||
      Array.isArray(obj.tierPrompts)
    ) {
      throw new Error("tiers.json: 'tierPrompts' must be an object");
    }
    const tp = obj.tierPrompts as Record<string, unknown>;
    for (const [tierName, prompt] of Object.entries(tp)) {
      if (typeof prompt !== "string") {
        throw new Error(
          `tiers.json: tierPrompts.'${tierName}' must be a string`,
        );
      }
    }
  }

  // Validate taskPatterns if present
  if (obj.taskPatterns !== undefined) {
    if (
      typeof obj.taskPatterns !== "object" ||
      obj.taskPatterns === null ||
      Array.isArray(obj.taskPatterns)
    ) {
      throw new Error("tiers.json: 'taskPatterns' must be an object");
    }
    const tp = obj.taskPatterns as Record<string, unknown>;
    for (const [tierName, patterns] of Object.entries(tp)) {
      if (
        !Array.isArray(patterns) ||
        !patterns.every((pattern) => typeof pattern === "string")
      ) {
        throw new Error(
          `tiers.json: taskPatterns.'${tierName}' must be an array of strings`,
        );
      }
    }
  }

  // Validate enforcement if present (optional — absent means no enforcement)
  if (obj.enforcement !== undefined) {
    if (
      typeof obj.enforcement !== "object" ||
      obj.enforcement === null ||
      Array.isArray(obj.enforcement)
    ) {
      throw new Error("tiers.json: enforcement must be an object");
    }
    const enforcement = obj.enforcement as Record<string, unknown>;
    if (enforcement.mode !== undefined) {
      if (!["off", "advisory", "enforced"].includes(enforcement.mode as string)) {
        throw new Error(
          "tiers.json: enforcement.mode must be one of off|advisory|enforced",
        );
      }
    }
    if (
      enforcement.verify !== undefined &&
      typeof enforcement.verify === "object" &&
      enforcement.verify !== null
    ) {
      const verify = enforcement.verify as Record<string, unknown>;
      if (
        verify.graderPolicy !== undefined &&
        verify.graderPolicy !== "atLeastProducerTier"
      ) {
        throw new Error(
          'tiers.json: enforcement.verify.graderPolicy must be "atLeastProducerTier"',
        );
      }
    }
    if (
      enforcement.escalate !== undefined &&
      typeof enforcement.escalate === "object" &&
      enforcement.escalate !== null
    ) {
      const escalate = enforcement.escalate as Record<string, unknown>;
      if (
        escalate.costCeiling !== undefined &&
        typeof escalate.costCeiling === "object" &&
        escalate.costCeiling !== null
      ) {
        const costCeiling = escalate.costCeiling as Record<string, unknown>;
        if (costCeiling.multiple !== undefined) {
          if (
            typeof costCeiling.multiple !== "number" ||
            costCeiling.multiple <= 0
          ) {
            throw new Error(
              "tiers.json: enforcement.escalate.costCeiling.multiple must be a number > 0",
            );
          }
        }
      }
      if (escalate.ladder !== undefined) {
        if (
          !Array.isArray(escalate.ladder) ||
          !escalate.ladder.every((s: unknown) => typeof s === "string")
        ) {
          throw new Error(
            "tiers.json: enforcement.escalate.ladder must be an array of strings",
          );
        }
      }
      if (escalate.maxAttemptsPerTier !== undefined) {
        if (
          typeof escalate.maxAttemptsPerTier !== "number" ||
          !Number.isInteger(escalate.maxAttemptsPerTier) ||
          escalate.maxAttemptsPerTier < 0
        ) {
          throw new Error(
            "tiers.json: enforcement.escalate.maxAttemptsPerTier must be an integer >= 0",
          );
        }
      }
      if (escalate.maxTotalAttempts !== undefined) {
        if (
          typeof escalate.maxTotalAttempts !== "number" ||
          !Number.isInteger(escalate.maxTotalAttempts) ||
          escalate.maxTotalAttempts < 1
        ) {
          throw new Error(
            "tiers.json: enforcement.escalate.maxTotalAttempts must be an integer >= 1",
          );
        }
      }
      if (
        escalate.floorTier !== undefined &&
        escalate.floorTier !== null &&
        typeof escalate.floorTier !== "string"
      ) {
        throw new Error(
          "tiers.json: enforcement.escalate.floorTier must be a string or null",
        );
      }
    }
    if (
      enforcement.perTier !== undefined &&
      typeof enforcement.perTier === "object" &&
      enforcement.perTier !== null &&
      !Array.isArray(enforcement.perTier)
    ) {
      const perTier = enforcement.perTier as Record<string, unknown>;
      for (const [tierName, tierMode] of Object.entries(perTier)) {
        if (!["off", "advisory", "enforced"].includes(tierMode as string)) {
          throw new Error(
            `tiers.json: enforcement.perTier.${tierName} must be one of off|advisory|enforced`,
          );
        }
      }
    }
    if (
      enforcement.guard !== undefined &&
      typeof enforcement.guard === "object" &&
      enforcement.guard !== null
    ) {
      const guard = enforcement.guard as Record<string, unknown>;
      if (guard.budget !== undefined) {
        if (
          typeof guard.budget !== "number" ||
          !Number.isFinite(guard.budget) ||
          guard.budget < 1
        ) {
          throw new Error("enforcement.guard.budget must be a number >= 1");
        }
      }
      if (guard.blockScriptWrites !== undefined) {
        if (typeof guard.blockScriptWrites !== "boolean") {
          throw new Error("enforcement.guard.blockScriptWrites must be a boolean");
        }
      }
    }
  }

  return raw as RouterConfig;
}

function shouldValidateLegacyConfig(raw: unknown): boolean {
  return (
    isPlainObject(raw) &&
    raw.schemaVersion !== 2 &&
    raw.models === undefined &&
    typeof raw.activePreset === "string" &&
    raw.presets !== undefined &&
    raw.rules !== undefined &&
    raw.defaultTier !== undefined
  );
}

/** Validate and normalize one complete v1 or v2 document for programmatic callers. */
export function validateConfig(raw: unknown): NormalizedRouterConfig {
  const normalized = normalizeConfigPatch(raw, "tiers.json", true);
  if (normalized.schema === 1) validateLegacyConfig(raw);
  const config = finalizeNormalizedConfig(
    normalized.patch,
    [normalized.schema],
    normalized.warnings,
  );
  validateLegacyConfig(config);
  return config;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fieldPath(parent: string, key: string): string {
  return parent === "$" ? key : `${parent}.${key}`;
}

function clearProvenanceBranch(
  provenance: Map<string, string>,
  path: string,
): void {
  const prefix = `${path}.`;
  for (const key of provenance.keys()) {
    if (key === path || key.startsWith(prefix)) provenance.delete(key);
  }
}

function recordProvenance(
  value: unknown,
  source: string,
  provenance: Map<string, string>,
  path = "$",
): void {
  provenance.set(path, source);
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    recordProvenance(child, source, provenance, fieldPath(path, key));
  }
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => cloneValue(item)) as T;
  }
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, cloneValue(child)]),
    ) as T;
  }
  return value;
}

function mergeLayer(
  base: unknown,
  override: unknown,
  source: string,
  provenance: Map<string, string>,
  path = "$",
): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const merged: Record<string, unknown> = { ...base };
    provenance.set(path, source);
    for (const [key, value] of Object.entries(override)) {
      const childPath = fieldPath(path, key);
      if (Object.hasOwn(merged, key)) {
        merged[key] = mergeLayer(
          merged[key],
          value,
          source,
          provenance,
          childPath,
        );
      } else {
        merged[key] = cloneValue(value);
        recordProvenance(value, source, provenance, childPath);
      }
    }
    return merged;
  }

  clearProvenanceBranch(provenance, path);
  const replacement = cloneValue(override);
  recordProvenance(replacement, source, provenance, path);
  return replacement;
}

function positionAt(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lastNewline = before.lastIndexOf("\n");
  return {
    line: before.split("\n").length,
    column: offset - lastNewline,
  };
}

function sourceError(
  path: string,
  text: string,
  offset: number,
  message: string,
): Error {
  const { line, column } = positionAt(text, offset);
  return new Error(`${path}:${line}:${column}: ${message}`);
}

function assertNoDuplicateKeys(
  node: JsoncNode,
  text: string,
  source: string,
  parentPath = "$",
): void {
  if (node.type === "object") {
    const seen = new Set<string>();
    for (const property of node.children ?? []) {
      const [keyNode, valueNode] = property.children ?? [];
      const key = keyNode?.value;
      if (typeof key !== "string") continue;
      const path = fieldPath(parentPath, key);
      if (seen.has(key)) {
        throw sourceError(source, text, keyNode.offset, `duplicate key '${path}'`);
      }
      seen.add(key);
      if (valueNode) assertNoDuplicateKeys(valueNode, text, source, path);
    }
    return;
  }

  if (node.type === "array") {
    for (const [index, child] of (node.children ?? []).entries()) {
      assertNoDuplicateKeys(child, text, source, `${parentPath}[${index}]`);
    }
  }
}

function parseConfigLayer(text: string, source: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text, errors, {
    allowTrailingComma: true,
    disallowComments: false,
    allowEmptyContent: false,
  });
  if (errors.length > 0) {
    const first = errors[0]!;
    throw sourceError(
      source,
      text,
      first.offset,
      `JSONC parse error: ${printParseErrorCode(first.error)}`,
    );
  }
  if (!tree) {
    throw sourceError(source, text, 0, "JSONC parse error: empty content");
  }
  assertNoDuplicateKeys(tree, text, source);
  return getNodeValue(tree);
}

function readLayer(
  kind: ConfigLayerKind,
  path: string,
  optional: boolean,
): ConfigLayer | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    if (
      optional &&
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: unable to read configuration: ${message}`);
  }
  return { kind, path, value: parseConfigLayer(text, path) };
}

function normalizeProjectRoot(projectRoot: string | undefined): string | undefined {
  if (!projectRoot || !projectRoot.trim()) return undefined;
  const normalized = resolve(projectRoot);
  return normalized === parsePath(normalized).root ? undefined : normalized;
}

function validationFieldPath(message: string): string {
  const normalized = message.replace(/^tiers\.json:\s*/u, "");
  const keyedBlock = normalized.match(
    /^(tierCaps|tierPrompts|taskPatterns)\.'([^']+)'/u,
  );
  if (keyedBlock) return `${keyedBlock[1]}.${keyedBlock[2]}`;

  const preset = normalized.match(/^preset '([^']+)'/u);
  if (preset) return `presets.${preset[1]}`;

  const tier = normalized.match(/^tier '([^']+)'/u);
  if (tier) return `presets.${tier[1]}`;

  const mode = normalized.match(/^mode '([^']+)'/u);
  if (mode) return `modes.${mode[1]}`;

  const quotedPath = normalized.match(/^'([^']+)'/u)?.[1];
  if (quotedPath) {
    return quotedPath.includes(".") ? `presets.${quotedPath}` : quotedPath;
  }
  const explicit = message.match(
    /(?:tiers\.json:\s*)?([A-Za-z][A-Za-z0-9_.]+)\s+must/u,
  )?.[1];
  return explicit ?? "$";
}

function provenanceSource(
  provenance: ReadonlyMap<string, string>,
  path: string,
  fallback: string,
): string {
  let current = path;
  while (current) {
    const source = provenance.get(current);
    if (source) return source;
    const dot = current.lastIndexOf(".");
    if (dot < 0) break;
    current = current.slice(0, dot);
  }
  return provenance.get("$") ?? fallback;
}

function sourceAwareValidationError(
  error: unknown,
  provenance: ReadonlyMap<string, string>,
  fallbackSource: string,
): never {
  const message = error instanceof Error ? error.message : String(error);
  const path = error instanceof ConfigValidationError
    ? error.fieldPath
    : validationFieldPath(message);
  const source = provenanceSource(provenance, path, fallbackSource);
  throw new Error(`${source}: field '${path}': ${message.replace(/^tiers\.json:\s*/u, "")}`);
}

function layerValidationError(error: unknown, source: string): never {
  const message = error instanceof Error ? error.message : String(error);
  const path = error instanceof ConfigValidationError
    ? error.fieldPath
    : validationFieldPath(message);
  throw new Error(`${source}: field '${path}': ${message.replace(/^tiers\.json:\s*/u, "")}`);
}

function projectDerivedModelProvenance(
  config: NormalizedRouterConfig,
  provenance: Map<string, string>,
  fallbackSource: string,
): void {
  const visit = (value: unknown, targetPath: string, sourcePath: string): void => {
    if (!provenance.has(targetPath)) {
      provenance.set(
        targetPath,
        provenanceSource(provenance, sourcePath, fallbackSource),
      );
    }
    if (!isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      visit(
        child,
        fieldPath(targetPath, key),
        fieldPath(sourcePath, key),
      );
    }
  };

  for (const [tier, model] of Object.entries(config.models)) {
    visit(
      model,
      `models.${tier}`,
      `presets.${config.activePreset}.${tier}`,
    );
  }
}

function cacheKey(options: ConfigLoadOptions): string {
  const projectRoot = normalizeProjectRoot(options.projectRoot);
  return [configPath(), globalConfigPath(), projectRoot ?? ""].join("\0");
}

export function loadConfigWithMetadata(
  options: ConfigLoadOptions = {},
): LoadedConfig {
  const key = cacheKey(options);
  const cached = _configCache.get(key);
  if (cached) return cached;

  const projectRoot = normalizeProjectRoot(options.projectRoot);
  const layers = [
    readLayer("bundled", configPath(), false),
    readLayer("global", globalConfigPath(), true),
    ...(projectRoot
      ? [readLayer("project", projectConfigPath(projectRoot), true)]
      : []),
  ].filter((layer): layer is ConfigLayer => layer !== undefined);

  const bundled = layers[0]!;
  const provenance = new Map<string, string>();
  let merged = cloneValue(bundled.value);
  recordProvenance(merged, bundled.path, provenance);
  for (const layer of layers.slice(1)) {
    merged = mergeLayer(merged, layer.value, layer.path, provenance);
  }

  if (shouldValidateLegacyConfig(merged)) {
    try {
      validateLegacyConfig(merged);
    } catch (error) {
      sourceAwareValidationError(error, provenance, bundled.path);
    }
  }

  const canonicalProvenance = new Map<string, string>();
  const schemas: ConfigSchemaVersion[] = [];
  const warnings: ConfigWarning[] = [];
  let canonicalMerged: unknown = {};
  for (const layer of layers) {
    let normalized;
    try {
      normalized = normalizeConfigPatch(
        layer.value,
        layer.path,
        layer.kind === "bundled",
      );
    } catch (error) {
      layerValidationError(error, layer.path);
    }
    schemas.push(normalized.schema);
    warnings.push(...normalized.warnings);
    canonicalMerged = mergeLayer(
      canonicalMerged,
      normalized.patch,
      layer.path,
      canonicalProvenance,
    );
  }

  let cfg: NormalizedRouterConfig;
  try {
    cfg = finalizeNormalizedConfig(canonicalMerged, schemas, warnings);
  } catch (error) {
    sourceAwareValidationError(
      error,
      canonicalProvenance,
      bundled.path,
    );
  }
  try {
    validateLegacyConfig(cfg);
  } catch (error) {
    sourceAwareValidationError(error, canonicalProvenance, bundled.path);
  }
  projectDerivedModelProvenance(cfg, canonicalProvenance, bundled.path);
  const state = readState();
  if (state.activePreset) {
    const resolved = resolvePresetName(cfg, state.activePreset);
    if (resolved) cfg.activePreset = resolved;
    else warnings.push({
      code: "persisted-state-ignored",
      message: `Unknown persisted preset '${state.activePreset}' was ignored`,
      source: statePath(),
      path: "activePreset",
    });
  }
  if (state.activeMode && cfg.modes?.[state.activeMode]) {
    cfg.activeMode = state.activeMode;
  } else if (state.activeMode) {
    warnings.push({
      code: "persisted-state-ignored",
      message: `Unknown persisted mode '${state.activeMode}' was ignored`,
      source: statePath(),
      path: "activeMode",
    });
  }
  if (state.enforcementMode) {
    cfg.enforcement = { ...(cfg.enforcement ?? {}), mode: state.enforcementMode };
  }
  Object.freeze(warnings);

  const result: LoadedConfig = {
    config: cfg,
    layers,
    provenance,
    canonicalProvenance,
    warnings,
  };
  _configCache.set(key, result);
  return result;
}

export function loadConfig(options: ConfigLoadOptions = {}): NormalizedRouterConfig {
  return loadConfigWithMetadata(options).config;
}

// ---------------------------------------------------------------------------
// State persistence helpers
// ---------------------------------------------------------------------------

function parseState(raw: unknown): RouterState {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }

  const input = raw as Record<string, unknown>;
  const state: RouterState = {};
  if (typeof input.activePreset === "string" && input.activePreset.trim()) {
    state.activePreset = input.activePreset.trim();
  }
  if (typeof input.activeMode === "string" && input.activeMode.trim()) {
    state.activeMode = input.activeMode.trim();
  }
  if (
    input.enforcementMode === "off" ||
    input.enforcementMode === "advisory" ||
    input.enforcementMode === "enforced"
  ) {
    state.enforcementMode = input.enforcementMode;
  }
  return state;
}

function readStateFile(path: string): RouterState {
  return parseState(JSON.parse(readFileSync(path, "utf-8")));
}

function writeStateFile(path: string, state: RouterState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** Read current persisted state, importing legacy state once when needed. */
export function readState(): RouterState {
  const currentPath = statePath();
  if (existsSync(currentPath)) {
    try {
      return readStateFile(currentPath);
    } catch {
      return {};
    }
  }

  const oldPath = legacyStatePath();
  if (!existsSync(oldPath)) return {};

  try {
    const state = readStateFile(oldPath);
    if (Object.keys(state).length > 0) {
      try {
        writeStateFile(currentPath, state);
      } catch {
        // Use valid legacy state for this process even if migration cannot persist.
      }
    }
    return state;
  } catch {
    return {};
  }
}

/** Write state to disk atomically (merges with existing keys). */
export function writeState(patch: Partial<RouterState>): void {
  const state = parseState({ ...readState(), ...patch });
  writeStateFile(statePath(), state);
}

// ---------------------------------------------------------------------------
// Enforcement helpers
// ---------------------------------------------------------------------------

/** Returns the effective enforcement mode. Missing enforcement ⇒ mode:"advisory". */
export function normalizeEnforcement(
  e: EnforcementConfig | undefined,
): { mode: "off" | "advisory" | "enforced" } {
  return { mode: e?.mode ?? "advisory" };
}
