import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  invalidateConfigCache,
  legacyStatePath,
  loadConfig,
  readState,
  statePath,
  writeState,
} from "../../src/router/config";

let tmpHome: string;
let origHOME: string | undefined;
let origUSERPROFILE: string | undefined;

beforeEach(() => {
  origHOME = process.env["HOME"];
  origUSERPROFILE = process.env["USERPROFILE"];
  tmpHome = mkdtempSync(join(tmpdir(), "oc-task-router-state-"));
  process.env["HOME"] = tmpHome;
  process.env["USERPROFILE"] = tmpHome;
  invalidateConfigCache();
});

afterEach(() => {
  if (origHOME === undefined) delete process.env["HOME"];
  else process.env["HOME"] = origHOME;
  if (origUSERPROFILE === undefined) delete process.env["USERPROFILE"];
  else process.env["USERPROFILE"] = origUSERPROFILE;
  invalidateConfigCache();
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", "utf8");
}

describe("writeState / readState — atomic file operations", () => {
  it("uses separate canonical and legacy state namespaces", () => {
    expect(statePath()).toBe(
      join(tmpHome, ".config", "opencode", "opencode-task-model-router.state.json"),
    );
    expect(legacyStatePath()).toBe(
      join(tmpHome, ".config", "opencode", "opencode-model-router.state.json"),
    );
  });

  it("(i) writeState then readState round-trips activePreset", () => {
    writeState({ activePreset: "openai" });
    expect(readState().activePreset).toBe("openai");
  });

  it("(ii) merge: subsequent writeState preserves earlier keys", () => {
    writeState({ activePreset: "openai" });
    writeState({ enforcementMode: "enforced" });
    const s = readState();
    expect(s.activePreset).toBe("openai");
    expect(s.enforcementMode).toBe("enforced");
  });

  it("(iii) state file is valid JSON ending in newline", () => {
    writeState({ activePreset: "anthropic" });
    const content = readFileSync(statePath(), "utf-8");
    // Throws if invalid JSON
    const parsed = JSON.parse(content) as Record<string, unknown>;
    expect(parsed.activePreset).toBe("anthropic");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("(iv) no leftover .tmp-* files after writeState", () => {
    writeState({ activePreset: "openai" });
    const dir = dirname(statePath());
    const files = readdirSync(dir);
    const tmps = files.filter((f) => f.includes(".tmp-"));
    expect(tmps).toHaveLength(0);
  });

  it("(v) enforcementMode persists round-trip", () => {
    writeState({ enforcementMode: "advisory" });
    expect(readState().enforcementMode).toBe("advisory");
  });

  it("readState returns {} when no state file exists", () => {
    expect(readState()).toEqual({});
    expect(existsSync(statePath())).toBe(false);
  });

  it("migrates valid legacy state without modifying the legacy file", () => {
    writeJson(legacyStatePath(), {
      activePreset: "openai",
      activeMode: "quality",
      enforcementMode: "enforced",
      ignored: "value",
    });
    const legacyBefore = readFileSync(legacyStatePath(), "utf8");

    expect(readState()).toEqual({
      activePreset: "openai",
      activeMode: "quality",
      enforcementMode: "enforced",
    });
    expect(JSON.parse(readFileSync(statePath(), "utf8"))).toEqual({
      activePreset: "openai",
      activeMode: "quality",
      enforcementMode: "enforced",
    });
    expect(readFileSync(legacyStatePath(), "utf8")).toBe(legacyBefore);
  });

  it("prefers canonical state when both files exist", () => {
    writeJson(legacyStatePath(), { activePreset: "openai" });
    writeJson(statePath(), { activePreset: "google" });

    expect(readState()).toEqual({ activePreset: "google" });
  });

  it("does not fall back to legacy state when canonical state is malformed", () => {
    writeJson(legacyStatePath(), { activePreset: "openai" });
    mkdirSync(dirname(statePath()), { recursive: true });
    writeFileSync(statePath(), "not json\n", "utf8");

    expect(readState()).toEqual({});
    expect(readFileSync(statePath(), "utf8")).toBe("not json\n");
  });

  it("ignores malformed legacy state without creating canonical state", () => {
    mkdirSync(dirname(legacyStatePath()), { recursive: true });
    writeFileSync(legacyStatePath(), "not json\n", "utf8");

    expect(readState()).toEqual({});
    expect(existsSync(statePath())).toBe(false);
  });

  it("filters invalid and unknown legacy fields", () => {
    writeJson(legacyStatePath(), {
      activePreset: "  openai  ",
      activeMode: 42,
      enforcementMode: "invalid",
      extra: true,
    });

    expect(readState()).toEqual({ activePreset: "openai" });
    expect(JSON.parse(readFileSync(statePath(), "utf8"))).toEqual({
      activePreset: "openai",
    });
  });

  it("loadConfig ignores unknown migrated preset and mode but applies enforcement", () => {
    writeJson(legacyStatePath(), {
      activePreset: "missing",
      activeMode: "missing",
      enforcementMode: "enforced",
    });

    const config = loadConfig();
    expect(config.activePreset).toBe("anthropic");
    expect(config.activeMode).not.toBe("missing");
    expect(config.enforcement?.mode).toBe("enforced");
  });

  it("writes only canonical state after migration and preserves migrated keys", () => {
    writeJson(legacyStatePath(), { activePreset: "openai" });
    const legacyBefore = readFileSync(legacyStatePath(), "utf8");

    writeState({ enforcementMode: "advisory" });

    expect(readState()).toEqual({
      activePreset: "openai",
      enforcementMode: "advisory",
    });
    expect(readFileSync(legacyStatePath(), "utf8")).toBe(legacyBefore);
  });
});
