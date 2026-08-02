/**
 * Smoke test: verify the model-router plugin's tool.execute.before hard-block
 * fires inside a real subagent session launched by `opencode run`.
 *
 * Trigger: a benign recon delegation that asks a fast subagent to read 6 files
 * sequentially with the Read tool.  In enforced mode the read_budget guard
 * (readDraftCap=3) fires on the 4th consecutive non-producing read and the
 * forcingMessage always contains "NEXT:".
 *
 * GATED: runs only when RUN_OC_SMOKE=1 is set AND the suite is invoked
 * explicitly with OPENCODE_SMOKE_MODEL set to an available local model ID.
 * Excluded from default `npm test` by vitest.config.ts exclude pattern.
 */
import { describe, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  createSmokeConfig,
  requireSmokeModel,
  runOpenCode,
} from "./support";

const RUN = process.env.RUN_OC_SMOKE === "1";
const d = RUN ? describe : describe.skip;

const REPO_ROOT = path.resolve(__dirname, "../..");
const OUT_DIR = path.join(REPO_ROOT, "tmp", "smoke");
const EVIDENCE_PREFIX = path.join(
  OUT_DIR,
  `guard-hardblock-${process.pid}`,
);
const STDOUT_FILE = `${EVIDENCE_PREFIX}.stdout.jsonl`;
const STDERR_FILE = `${EVIDENCE_PREFIX}.stderr.log`;
const PLUGIN_PATH = path.join(REPO_ROOT, "src", "index.ts");

// Benign recon prompt: asks a fast subagent to read 6 files one-at-a-time.
// readDraftCap=3 means after 3 consecutive reads (non-producing actions),
// the 4th read is blocked; the forcingMessage always contains "NEXT:" and
// the read_budget observation contains "read/draft".
const PROMPT =
  'Use Task(subagent_type="fast", description="recon", prompt="This is a non-trivial code-review smoke verification. Read these files ONE AT A TIME using the read tool, in this exact order, and after each give a one-line summary: README.md, then package.json, then tsconfig.json, then tiers.json, then LICENSE, then src/index.ts. Use the read tool separately for each file; do not skip any.\n\n[acceptance]\ncheck: fileExists path=README.md\n[/acceptance]"). After the subagent returns, reply with the single word DONE.';

type JsonObject = Record<string, unknown>;

interface ParsedJsonlEvent {
  line: number;
  raw: string;
  value?: JsonObject;
  parseError?: string;
}

interface ToolOccurrence {
  event: ParsedJsonlEvent;
  object: JsonObject;
  path: string;
  tool: "task" | "read";
  callID: string;
  status?: string;
}

interface SmokeEvidence {
  events: ParsedJsonlEvent[];
  relevantEvents: ParsedJsonlEvent[];
  taskTools: ToolOccurrence[];
  readTools: ToolOccurrence[];
  taskStates: unknown[];
  taskOutputs: string[];
  toolErrors: string[];
  guardCodes: string[];
  guardTexts: string[];
  taskStatus: string;
}

const FAILURE_STATUSES = new Set(["denied", "error", "failed", "rejected"]);
const TEXT_KEYS = new Set([
  "error",
  "message",
  "observation",
  "output",
  "reason",
  "result",
  "text",
]);
const GUARD_CODE_PATTERN =
  /\b(read_budget|redundant_read|anti_self_script|pre_deliverable|iteration_cap)\b/giu;
const GUARD_TEXT_PATTERN =
  /(?:\[.?\s*GUARD:[^\]]+\]|DENIED:\s*read\/draft[^\n]*|read\/draft budget (?:exhausted|gate)[^\n]*|\bbudget exhaustion\b|\b(?:environment|runtime budget) guard[^\n]*(?:block|refus)[^\n]*reads?|\bNEXT:\s*[^\n]*)/giu;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonl(stdout: string): ParsedJsonlEvent[] {
  const events: ParsedJsonlEvent[] = [];
  for (const [index, raw] of stdout.split(/\r?\n/u).entries()) {
    if (!raw.trim()) continue;
    try {
      const value: unknown = JSON.parse(raw);
      events.push({
        line: index + 1,
        raw,
        ...(isObject(value)
          ? { value }
          : { parseError: "JSONL value is not an object" }),
      });
    } catch (error) {
      events.push({
        line: index + 1,
        raw,
        parseError: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return events;
}

function walkObjects(
  value: unknown,
  visit: (object: JsonObject, path: string) => void,
  objectPath = "$",
): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) =>
      walkObjects(child, visit, `${objectPath}[${index}]`),
    );
    return;
  }
  if (!isObject(value)) return;
  visit(value, objectPath);
  for (const [key, child] of Object.entries(value)) {
    walkObjects(child, visit, `${objectPath}.${key}`);
  }
}

function collectTextFields(value: unknown): string[] {
  const texts: string[] = [];
  const visit = (current: unknown): void => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isObject(current)) return;
    for (const [key, child] of Object.entries(current)) {
      if (typeof child === "string" && TEXT_KEYS.has(key)) texts.push(child);
      else visit(child);
    }
  };
  visit(value);
  return texts;
}

function firstString(
  object: JsonObject,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    if (typeof object[key] === "string") return object[key];
  }
  return undefined;
}

function inspectSmokeEvidence(stdout: string): SmokeEvidence {
  const events = parseJsonl(stdout);
  const taskTools: ToolOccurrence[] = [];
  const readTools: ToolOccurrence[] = [];
  const taskStates: unknown[] = [];
  const taskOutputs: string[] = [];
  const toolErrors: string[] = [];
  const guardCodes = new Set<string>();
  const guardTexts = new Set<string>();
  const relevantEvents = new Map<number, ParsedJsonlEvent>();

  for (const event of events) {
    if (!event.value) continue;
    const eventTexts = collectTextFields(event.value);

    for (const text of eventTexts) {
      for (const match of text.matchAll(GUARD_CODE_PATTERN)) {
        guardCodes.add(match[1]!.toLowerCase());
        relevantEvents.set(event.line, event);
      }
      for (const match of text.matchAll(GUARD_TEXT_PATTERN)) {
        guardTexts.add(match[0]);
        relevantEvents.set(event.line, event);
      }
    }

    walkObjects(event.value, (object, objectPath) => {
      const explicitTool = firstString(object, ["tool", "toolName"]);
      const eventType = firstString(object, ["type", "kind"]);
      const namedTool =
        eventType === "tool_use" || eventType === "tool"
          ? firstString(object, ["name"])
          : undefined;
      const normalizedTool = (explicitTool ?? namedTool)?.toLowerCase();
      if (normalizedTool !== "task" && normalizedTool !== "read") return;

      const state = isObject(object.state) ? object.state : undefined;
      const status = (
        firstString(state ?? {}, ["status"]) ?? firstString(object, ["status"])
      )?.toLowerCase();
      const callID =
        firstString(object, ["callID", "callId", "id"]) ??
        firstString(state ?? {}, ["callID", "callId", "id"]) ??
        `${event.line}:${objectPath}`;
      const occurrence: ToolOccurrence = {
        event,
        object,
        path: objectPath,
        tool: normalizedTool,
        callID,
        status,
      };
      const target = normalizedTool === "task" ? taskTools : readTools;
      target.push(occurrence);
      relevantEvents.set(event.line, event);

      if (normalizedTool === "task") {
        if (state) taskStates.push(state);
        taskOutputs.push(...collectTextFields(state ?? object));
      }
      if (status && FAILURE_STATUSES.has(status)) {
        const details = collectTextFields(state ?? object).join(" | ");
        toolErrors.push(
          `${normalizedTool} ${callID} ${status}${details ? `: ${details}` : ""}`,
        );
      }
    });

    const topStatus = firstString(event.value, ["status"])?.toLowerCase();
    const topType = firstString(event.value, ["type"]);
    if (
      topType === "error" ||
      (topStatus !== undefined && FAILURE_STATUSES.has(topStatus))
    ) {
      const details = eventTexts.join(" | ") || event.raw;
      toolErrors.push(`${topType ?? "event"} ${topStatus ?? "error"}: ${details}`);
      relevantEvents.set(event.line, event);
    }
  }

  const uniqueTaskTools = deduplicateTools(taskTools);
  const uniqueReadTools = deduplicateTools(readTools);
  const statuses = taskTools
    .map((tool) => tool.status)
    .filter((status): status is string => status !== undefined);
  const taskStatus = statuses.includes("completed")
    ? "completed"
    : statuses.some((status) => FAILURE_STATUSES.has(status))
      ? "failed"
      : statuses.at(-1) ?? "unknown";

  return {
    events,
    relevantEvents: [...relevantEvents.values()].sort((a, b) => a.line - b.line),
    taskTools: uniqueTaskTools,
    readTools: uniqueReadTools,
    taskStates,
    taskOutputs,
    toolErrors: [...new Set(toolErrors)],
    guardCodes: [...guardCodes],
    guardTexts: [...guardTexts],
    taskStatus,
  };
}

function deduplicateTools(tools: ToolOccurrence[]): ToolOccurrence[] {
  const byCall = new Map<string, ToolOccurrence>();
  for (const tool of tools) byCall.set(tool.callID, tool);
  return [...byCall.values()];
}

function compactEvent(event: ParsedJsonlEvent): string {
  const content = event.value ? JSON.stringify(event.value) : event.raw;
  const compact = content.length > 1_000 ? `${content.slice(0, 1_000)}...` : content;
  return `line ${event.line}: ${compact}`;
}

function formatDiagnosis(evidence: SmokeEvidence): string {
  const lastEvents = evidence.relevantEvents.slice(-20);
  return [
    "Guard smoke diagnosis:",
    `- read calls: ${evidence.readTools.length}`,
    `- task status: ${evidence.taskStatus}`,
    `- task outputs: ${evidence.taskOutputs.length}`,
    `- guard codes: ${evidence.guardCodes.join(", ") || "none"}`,
    `- guard text found: ${evidence.guardTexts.length > 0 ? "yes" : "no"}`,
    `- tool errors/rejections: ${evidence.toolErrors.length}`,
    `- malformed JSONL lines: ${evidence.events.filter((event) => event.parseError).length}`,
    `- stdout evidence: ${STDOUT_FILE}`,
    `- stderr evidence: ${STDERR_FILE}`,
    "- last 20 relevant JSONL events:",
    ...(lastEvents.length > 0
      ? lastEvents.map((event) => `  ${compactEvent(event)}`)
      : ["  none"]),
  ].join("\n");
}

d("guard hard-block smoke", () => {
  it(
    "read_budget guard fires inside a subagent session (benign recon trigger)",
    async () => {
      const model = requireSmokeModel();
      const smokeConfig = createSmokeConfig("guard-hardblock", PLUGIN_PATH);
      try {
        fs.mkdirSync(OUT_DIR, { recursive: true });

        const result = await runOpenCode({
          args: [
            "run",
            PROMPT,
            "--model",
            model,
            "--format",
            "json",
            "--dangerously-skip-permissions",
          ],
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            OPENCODE_CONFIG: smokeConfig.path,
            OPENCODE_DISABLE_PROJECT_CONFIG: "1",
            TASK_MODEL_ROUTER_ENFORCE: "1",
          },
        });

        const elapsed = (result.elapsedMs / 1000).toFixed(1);
        console.log(`opencode exited in ${elapsed}s, status=${result.code}`);

        const { stdout, stderr } = result;

        fs.writeFileSync(STDOUT_FILE, stdout, "utf8");
        fs.writeFileSync(STDERR_FILE, stderr, "utf8");
        console.log(`stdout evidence: ${STDOUT_FILE}`);
        console.log(`stderr evidence: ${STDERR_FILE}`);

        const evidence = inspectSmokeEvidence(stdout);
        const diagnosis = formatDiagnosis(evidence);

        if (
          result.code !== 0 ||
          result.signal !== null ||
          result.timedOut ||
          result.overflowed ||
          result.spawnError
        ) {
          throw new Error(
            `opencode failed: code=${result.code}, signal=${result.signal}, timedOut=${result.timedOut}, overflowed=${result.overflowed}, spawnError=${result.spawnError?.message ?? "none"}.\n${diagnosis}`,
          );
        }

        const modelFailure = `${stdout}\n${stderr}`.match(
          /ProviderModelNotFoundError|Model not found:/iu,
        );
        if (modelFailure) {
          throw new Error(
            `Smoke used an unavailable model: ${modelFailure[0]}.\n${diagnosis}`,
          );
        }
        if (/"subagent_type"\s*:\s*"medium"/u.test(stdout)) {
          throw new Error(
            `Guard-only smoke unexpectedly escalated to medium.\n${diagnosis}`,
          );
        }

        if (
          !evidence.guardCodes.includes("read_budget") &&
          evidence.guardTexts.length === 0
        ) {
          throw new Error(
            `Read-guard DID NOT produce structured code or text evidence.\n${diagnosis}`,
          );
        }

        console.log(diagnosis);
      } finally {
        smokeConfig.cleanup();
      }
    },
    185_000,
  );
});
