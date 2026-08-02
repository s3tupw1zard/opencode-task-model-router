import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import {
  createSmokeConfig,
  requireSmokeModel,
  SMOKE_MODEL_ERROR,
} from "../smoke/support";

describe("live smoke model configuration", () => {
  it.each([undefined, "", "   "])(
    "fails clearly when OPENCODE_SMOKE_MODEL is %j",
    (model) => {
      expect(() =>
        requireSmokeModel(
          model === undefined ? {} : { OPENCODE_SMOKE_MODEL: model },
        ),
      ).toThrow(SMOKE_MODEL_ERROR);
    },
  );

  it("returns the configured model ID unchanged", () => {
    const model = "  provider/model-id  ";
    expect(requireSmokeModel({ OPENCODE_SMOKE_MODEL: model })).toBe(model);
  });

  it("creates isolated configs and removes their temporary directories", () => {
    const first = createSmokeConfig("first", "/plugin/index.ts");
    const second = createSmokeConfig("second", "/plugin/index.ts");
    try {
      expect(first.path).not.toBe(second.path);
      expect(first.path).not.toContain(process.cwd());
      const config = JSON.parse(readFileSync(first.path, "utf8")) as {
        plugin: string[];
      };
      expect(config.plugin[0]).toBe("/plugin/index.ts");
      expect(config.plugin[1]).toMatch(/smoke-model-plugin\.js$/u);
      expect(readFileSync(config.plugin[1]!, "utf8")).toContain(
        "config.agent.fast.model = model",
      );
    } finally {
      first.cleanup();
      second.cleanup();
    }
    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });
});
