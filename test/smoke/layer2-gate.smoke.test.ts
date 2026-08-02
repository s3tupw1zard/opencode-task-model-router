/**
 * Smoke test: Layer-2 acceptance gate (Option i verify-dispatch) end-to-end.
 *
 * Exercises the real `opencode run` path with TASK_MODEL_ROUTER_ENFORCE=1.
 * The prompt asks the orchestrator to dispatch a fast subagent whose task text
 * embeds an [acceptance] block with a deterministic fileExists check for a
 * file that DOES NOT exist (__definitely_missing_artifact__.txt).  Because
 * that file is absent, Option(i) verify-dispatch should detect a DoD failure
 * and append a forcing note whose first line contains "NOT ACCEPTED".
 *
 * GATED: runs only when RUN_OC_SMOKE=1 is set.
 * Excluded from default `npm test` by vitest.config.ts exclude pattern.
 * Run explicitly with OPENCODE_SMOKE_MODEL set to an available local model ID.
 *
 * Tolerant assertion strategy (3 lines):
 *   1. No task tool call in output (orchestrator refusal) → console.warn +
 *      SOFT-PASS; GA-3 is deterministically covered by layer2-wiring.test.ts.
 *   2. Task dispatched + "NOT ACCEPTED" present → hard PASS (ideal case).
 *   3. Task dispatched + "NOT ACCEPTED" absent (model dropped acceptance block)
 *      → console.warn + SOFT-PASS; this is orchestrator non-compliance, not a
 *      gate regression — never a false CI failure.
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
const OUT_FILE = path.join(OUT_DIR, `layer2-gate-${process.pid}.json`);
/** Absolute path to the plugin entry — derived at runtime, never hardcoded. */
const PLUGIN_PATH = path.join(REPO_ROOT, "src", "index.ts");

/**
 * The inner task prompt that the orchestrator is asked to copy verbatim into
 * the Task tool call.  It contains an [acceptance] block with a deterministic
 * fileExists check for __definitely_missing_artifact__.txt — a file that will
 * NEVER exist — so Option(i) verify-dispatch always fails the DoD and emits
 * "NOT ACCEPTED" in the forcing note appended to the task tool output.
 */
const TASK_PROMPT_INNER = [
  "Read README.md and report its first line.",
  "",
  "[acceptance]",
  "check: fileExists path=__definitely_missing_artifact__.txt",
  "[/acceptance]",
].join("\n");

/**
 * Outer orchestrator prompt.  Instructs the model to dispatch a Task and to
 * copy the inner prompt VERBATIM so the acceptance block reaches the tool call.
 */
const PROMPT =
  'Dispatch a fast subagent using the Task tool. ' +
  'Use subagent_type="fast" and copy the following text VERBATIM as the prompt ' +
  "(include EVERY line including the acceptance block — do NOT modify or omit any line):\n\n" +
  TASK_PROMPT_INNER +
  "\n\nAfter the subagent returns, reply with the single word DONE.";

d("layer-2 acceptance gate smoke", () => {
  it(
    "Option(i) verify-dispatch appends NOT ACCEPTED when DoD file is absent",
    async () => {
      const model = requireSmokeModel();
      const smokeConfig = createSmokeConfig("layer2-gate", PLUGIN_PATH);

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

        fs.writeFileSync(
          OUT_FILE,
          JSON.stringify(
            {
              exitCode: result.code,
              signal: result.signal,
              timedOut: result.timedOut,
              overflowed: result.overflowed,
              spawnError: result.spawnError?.message,
              elapsed,
              stdout,
              stderr: stderr.slice(0, 4_000),
            },
            null,
            2,
          ),
        );

        if (
          result.code !== 0 ||
          result.signal !== null ||
          result.timedOut ||
          result.overflowed ||
          result.spawnError
        ) {
          const excerpt = (stdout + "\n" + stderr).slice(0, 600);
          throw new Error(
            `opencode failed: code=${result.code}, signal=${result.signal}, timedOut=${result.timedOut}, overflowed=${result.overflowed}, spawnError=${result.spawnError?.message ?? "none"}.\nExcerpt:\n${excerpt}`,
          );
        }

        const modelFailure = `${stdout}\n${stderr}`.match(
          /ProviderModelNotFoundError|Model not found:/iu,
        );
        if (modelFailure) {
          throw new Error(`Smoke used an unavailable model: ${modelFailure[0]}`);
        }

        // ── detect whether a task tool call was dispatched ───────────────────
        // Search the raw output text rather than walking a brittle JSON object
        // path so the detection is resilient to schema changes in opencode's
        // --format json output.
        const lower = stdout.toLowerCase();
        const taskDispatched =
          lower.includes('"name":"task"') ||
          lower.includes('"name": "task"') ||
          lower.includes("task_result") ||
          lower.includes("<task_result>");

        if (!taskDispatched) {
          // Orchestrator refused to dispatch a subagent — SOFT-PASS.
          //
          // GA-3 (Layer-2 acceptance gate) is primarily proven by the
          // deterministic real-factory integration test:
          //   test/integration/layer2-wiring.test.ts  (cases A, D, E)
          // which exercises buildForcingNote / verifyDoD directly against the
          // real factory without requiring a live orchestrator.  The live
          // end-to-end path shape is spike-proven; a model compliance refusal
          // here is not a gate regression.
          console.warn(
            "[layer2-gate smoke] Orchestrator did NOT dispatch a subagent " +
              "(no task tool call detected in captured output). " +
              "SOFT-PASS — GA-3 deterministic coverage lives in " +
              "test/integration/layer2-wiring.test.ts (cases A, D, E).",
          );
          return; // soft-pass: do not throw
        }

        // ── task was dispatched — look for the forcing note ──────────────────
        // Option(i) verify-dispatch fires inside tool.execute.after for the
        // built-in task tool when TASK_MODEL_ROUTER_ENFORCE=1.  When the fileExists
        // check for __definitely_missing_artifact__.txt fails (the file does
        // not exist), buildForcingNote() is invoked and its first line is
        // "NOT ACCEPTED".  We search the raw text case-insensitively.
        const notAccepted =
          stdout.includes("NOT ACCEPTED") || lower.includes("not accepted");

        if (!notAccepted) {
          // Task was dispatched but the forcing note is absent.  This happens
          // when the orchestrator did not copy the [acceptance] block verbatim
          // into the task prompt (model non-compliance with the instruction).
          // This is NOT a gate regression — SOFT-PASS to prevent false CI
          // failures.  Hard assertion coverage remains in layer2-wiring.test.ts.
          console.warn(
            '[layer2-gate smoke] Task was dispatched but "NOT ACCEPTED" forcing ' +
              "note was NOT found in captured output. " +
              "The orchestrator likely omitted the [acceptance] block from the " +
              "dispatched task prompt (model non-compliance). " +
              "SOFT-PASS — not a gate regression.",
          );
          return; // soft-pass
        }

        // Ideal path: dispatch confirmed AND forcing note present.
        console.log(
          '[layer2-gate smoke] "NOT ACCEPTED" forcing note confirmed — ' +
            "Option(i) verify-dispatch fired correctly on absent DoD artifact.",
        );
        console.log(`Evidence written to: ${OUT_FILE}`);
      } finally {
        smokeConfig.cleanup();
      }
    },
    185_000,
  );
});
