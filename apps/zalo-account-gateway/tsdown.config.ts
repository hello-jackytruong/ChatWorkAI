import { defineConfig } from "tsdown"

export default defineConfig({
  format: ["esm"],
  entry: ["src/main.ts"],
  dts: false,
  shims: true,
  clean: true,
  platform: "node",
  minify: false,
  sourcemap: true,
  treeshake: true,
})
