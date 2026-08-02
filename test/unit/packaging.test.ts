import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

interface PackResult {
  name: string;
  version: string;
  filename: string;
  files: Array<{ path: string }>;
}

// Plan C4 / R9: tests and dev-only config must NEVER ship in the npm package.
// The package.json `files` allowlist is the mechanism; this test is the guard
// that proves it stays correct as the test/ tree and tooling grow.
describe("packaging: published tarball excludes tests and dev config (plan C4)", () => {
  it("npm pack --dry-run ships only the allowlisted files", () => {
    const raw = execSync("npm pack --dry-run --json", {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(raw) as PackResult[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      name: "opencode-task-model-router",
      version: "1.3.0",
      filename: "opencode-task-model-router-1.3.0.tgz",
    });
    const paths = parsed
      .flatMap((p) => p.files.map((f) => f.path.replace(/\\/g, "/")))
      .sort();

    // MUST NOT ship tests, docs, tmp, coverage, or dev config.
    expect(paths.some((p) => p.startsWith("test/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("docs/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("tmp/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("coverage/"))).toBe(false);
    expect(paths).not.toContain("tsconfig.json");
    expect(paths).not.toContain("vitest.config.ts");
    expect(paths).not.toContain("vitest.smoke.config.ts");
    expect(paths).not.toContain("docs/CONFIG_REFERENCE.md");
    expect(paths).not.toContain("docs/CONFIGURATION.md");

    // MUST ship the runtime entry point and config.
    expect(paths).toContain("package.json");
    expect(paths).toContain("README.md");
    expect(paths).toContain("LICENSE");
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("src/router/config.ts");
    expect(paths).toContain("tiers.json");
  });

  it("publishes the fork identity while preserving upstream attribution", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      name: string;
      version: string;
      author: { name: string; url: string };
      contributors: Array<{ name: string; url: string }>;
      dependencies: Record<string, string>;
      repository: { url: string };
      homepage: string;
      bugs: { url: string };
    };

    expect(pkg).toMatchObject({
      name: "opencode-task-model-router",
      version: "1.3.0",
      author: {
        name: "s3tupw1zard",
        url: "https://github.com/s3tupw1zard",
      },
      repository: {
        url: "git+https://github.com/s3tupw1zard/opencode-task-model-router.git",
      },
      homepage: "https://github.com/s3tupw1zard/opencode-task-model-router",
      bugs: {
        url: "https://github.com/s3tupw1zard/opencode-task-model-router/issues",
      },
      dependencies: {
        "jsonc-parser": "^3.3.1",
      },
    });
    expect(pkg.contributors).toContainEqual({
      name: "Marco Jardim",
      url: "https://github.com/marco-jardim",
    });
    expect(JSON.stringify(pkg)).not.toContain(
      "github.com/marco-jardim/opencode-model-router",
    );

    const readme = readFileSync("README.md", "utf8");
    expect(readme).toContain("npm install -g opencode-task-model-router");
    expect(readme).toContain('"plugin": ["opencode-task-model-router"]');

    const license = readFileSync("LICENSE", "utf8");
    expect(license).toContain("opencode-task-model-router - OpenCode plugin");
    expect(license).toContain("Copyright (C) 2026  Marco Jardim");
  });
});
