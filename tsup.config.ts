import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli/index.ts", "src/server/main.ts"],
  format: ["esm"],
  target: "node20",
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
