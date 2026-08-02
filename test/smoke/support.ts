import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SMOKE_MODEL_ERROR =
  'OPENCODE_SMOKE_MODEL is required for live smoke tests. Set it to an available OpenCode model ID, for example: OPENCODE_SMOKE_MODEL="provider/model-id" npm run smoke';

export function requireSmokeModel(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const model = env.OPENCODE_SMOKE_MODEL;
  if (!model?.trim()) throw new Error(SMOKE_MODEL_ERROR);
  return model;
}

export function createSmokeConfig(
  testName: string,
  pluginPath: string,
): { path: string; cleanup: () => void } {
  const directory = mkdtempSync(
    join(tmpdir(), `opencode-task-model-router-${testName}-`),
  );
  const path = join(directory, "opencode.json");
  const modelOverridePath = join(directory, "smoke-model-plugin.js");
  writeFileSync(
    modelOverridePath,
    `export default async () => ({
  config(config) {
    const model = process.env.OPENCODE_SMOKE_MODEL;
    if (config.agent?.fast && model) config.agent.fast.model = model;
  },
});
`,
    "utf8",
  );
  writeFileSync(
    path,
    JSON.stringify(
      {
        $schema: "https://opencode.ai/config.json",
        plugin: [pluginPath, modelOverridePath],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return {
    path,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
