import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node18",
  bundle: true,
  splitting: false,
  sourcemap: true,
  dts: true,
  minify: false,
  clean: false,
  external: ["@opencode-ai/plugin", "jsonc-parser"],
  outDir: "dist",
});
