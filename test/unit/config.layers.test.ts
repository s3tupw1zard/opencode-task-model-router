import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  globalConfigPath,
  invalidateConfigCache,
  loadConfig,
  loadConfigWithMetadata,
  projectConfigPath,
} from "../../src/router/config";

describe.sequential("layered JSONC configuration", () => {
  let home: string;
  let projects: string;
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;

  beforeEach(() => {
    savedHome = process.env.HOME;
    savedUserProfile = process.env.USERPROFILE;
    home = mkdtempSync(join(tmpdir(), "oc-task-router-config-home-"));
    projects = mkdtempSync(join(tmpdir(), "oc-task-router-projects-"));
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    if (savedUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = savedUserProfile;
    invalidateConfigCache();
    rmSync(home, { recursive: true, force: true });
    rmSync(projects, { recursive: true, force: true });
  });

  function write(path: string, content: string): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, "utf8");
  }

  function project(name: string): string {
    const path = join(projects, name);
    mkdirSync(path, { recursive: true });
    return path;
  }

  it("silently skips missing optional global and project files", () => {
    const root = project("missing");
    const loaded = loadConfigWithMetadata({ projectRoot: root });

    expect(loaded.config.activePreset).toBe("anthropic");
    expect(loaded.layers.map((layer) => layer.kind)).toEqual(["bundled"]);
  });

  it("accepts comments and trailing commas in global overrides", () => {
    write(
      globalConfigPath(),
      `{
        // Keep this file user-friendly.
        "defaultTier": "heavy",
        "customPhase3Field": true,
      }`,
    );

    const loaded = loadConfigWithMetadata();
    expect(loaded.config.defaultTier).toBe("heavy");
    expect((loaded.config as unknown as Record<string, unknown>).customPhase3Field).toBe(true);
    expect(loaded.layers.map((layer) => layer.kind)).toEqual(["bundled", "global"]);
    expect(loaded.provenance.get("defaultTier")).toBe(globalConfigPath());
  });

  it("applies global then project overrides with recursive object merging", () => {
    const root = project("precedence");
    write(
      globalConfigPath(),
      JSON.stringify({
        defaultTier: "fast",
        phase3: {
          nested: { inherited: true, replaced: "global" },
          list: ["global", "values"],
          nullable: "global",
        },
      }),
    );
    write(
      projectConfigPath(root),
      JSON.stringify({
        defaultTier: "heavy",
        phase3: {
          nested: { replaced: "project" },
          list: ["project"],
          nullable: null,
        },
      }),
    );

    const loaded = loadConfigWithMetadata({ projectRoot: root });
    const phase3 = (loaded.config as unknown as { phase3: Record<string, unknown> }).phase3;
    expect(loaded.config.defaultTier).toBe("heavy");
    expect(phase3).toEqual({
      nested: { inherited: true, replaced: "project" },
      list: ["project"],
      nullable: null,
    });
    expect(loaded.provenance.get("phase3.nested.inherited")).toBe(globalConfigPath());
    expect(loaded.provenance.get("phase3.nested.replaced")).toBe(projectConfigPath(root));
    expect(loaded.provenance.get("phase3.list")).toBe(projectConfigPath(root));
    expect(loaded.provenance.get("phase3.nullable")).toBe(projectConfigPath(root));
  });

  it("replaces arrays instead of concatenating them", () => {
    const root = project("arrays");
    write(globalConfigPath(), JSON.stringify({ rules: ["global"] }));
    write(projectConfigPath(root), JSON.stringify({ rules: ["project"] }));

    expect(loadConfig({ projectRoot: root }).rules).toEqual(["project"]);
  });

  it("reports JSONC syntax errors with the source line and column", () => {
    const root = project("syntax");
    const path = projectConfigPath(root);
    write(path, `{
  "defaultTier":,
}`);

    expect(() => loadConfig({ projectRoot: root })).toThrow(
      new RegExp(`${path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:2:\\d+: JSONC parse error:`),
    );
  });

  it("rejects duplicate keys with their source and field path", () => {
    const root = project("duplicate");
    const path = projectConfigPath(root);
    write(path, `{
  "defaultTier": "fast",
  "defaultTier": "heavy"
}`);

    expect(() => loadConfig({ projectRoot: root })).toThrow(
      `${path}:3:3: duplicate key 'defaultTier'`,
    );
  });

  it.each([
    ["empty", ""],
    ["comment-only", "// no values yet\n/* still empty */\n"],
  ])("rejects a present %s optional file", (_label, content) => {
    write(globalConfigPath(), content);

    expect(() => loadConfig()).toThrow(new RegExp(`${globalConfigPath()}.*JSONC parse error`));
  });

  it("attributes final validation errors to the overriding source and exact field", () => {
    const root = project("validation");
    const path = projectConfigPath(root);
    write(
      path,
      JSON.stringify({ presets: { anthropic: { fast: { model: "" } } } }),
    );

    expect(() => loadConfig({ projectRoot: root })).toThrow(
      `${path}: field 'presets.anthropic.fast.model'`,
    );
  });

  it("isolates cache entries by project and invalidates all entries explicitly", () => {
    const first = project("first");
    const second = project("second");
    write(projectConfigPath(first), JSON.stringify({ defaultTier: "fast" }));
    write(projectConfigPath(second), JSON.stringify({ defaultTier: "heavy" }));

    const firstConfig = loadConfig({ projectRoot: first });
    expect(firstConfig.defaultTier).toBe("fast");
    expect(loadConfig({ projectRoot: first })).toBe(firstConfig);
    expect(loadConfig({ projectRoot: second }).defaultTier).toBe("heavy");

    write(projectConfigPath(first), JSON.stringify({ defaultTier: "medium" }));
    expect(loadConfig({ projectRoot: first }).defaultTier).toBe("fast");
    invalidateConfigCache();
    expect(loadConfig({ projectRoot: first }).defaultTier).toBe("medium");
  });

  it("does not hide non-ENOENT read failures for optional files", () => {
    mkdirSync(globalConfigPath(), { recursive: true });

    expect(() => loadConfig()).toThrow(
      new RegExp(`${globalConfigPath()}.*unable to read configuration`),
    );
  });
});
