import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// GitHub Pages serves this project under /laya-bot-det/.
const base = process.env.VITE_BASE ?? "/laya-bot-det/";

const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;

/** The commit the page was built from, so a deployed page can be told apart from
 *  the one before it. Actions sets GITHUB_SHA; locally this asks git. */
function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

// Only the two execution providers `src/laya/load.ts` asks for: jsep backs webgpu,
// the plain build backs wasm. The asyncify and jspi builds are another 44 MB that
// nothing here would fetch. Named one by one rather than globbed, so each lands
// flat in `dist/ort/` where `wasmPaths` looks for it.
const ORT_DIR = "node_modules/onnxruntime-web/dist";
const ORT_RUNTIME = [
  "ort-wasm-simd-threaded.jsep.wasm",
  "ort-wasm-simd-threaded.jsep.mjs",
  "ort-wasm-simd-threaded.wasm",
  "ort-wasm-simd-threaded.mjs",
];

/**
 * onnxruntime-web's loader carries a `new URL("ort-wasm-....wasm", import.meta.url)`
 * fallback. Rollup detects that statically and emits the file as a hashed asset,
 * ~28 MB, even though it is never fetched: `wasmPaths` always points onnxruntime-web
 * at `dist/ort/`, which `viteStaticCopy` fills explicitly. Rollup cannot know that
 * from the source, so without this the same wasm ships twice.
 *
 * Adapted from mizchi's fork of laya-mlx (Apache-2.0); see NOTICE.
 */
function dropOrtWasmFallbackAssets(): Plugin {
  return {
    name: "laya-bot-det:drop-ort-wasm-fallback-assets",
    generateBundle(_options, bundle) {
      for (const fileName of Object.keys(bundle)) {
        if (/^assets\/ort-wasm.*\.(wasm|mjs)$/.test(fileName)) delete bundle[fileName];
      }
    },
  };
}

export default defineConfig({
  base,
  plugins: [
    react(),
    viteStaticCopy({
      targets: ORT_RUNTIME.map((file) => ({
        src: `${ORT_DIR}/${file}`,
        dest: "ort",
        // Without this the source's directory segments are kept, landing the
        // files under dist/ort/node_modules/... where wasmPaths never looks.
        rename: { stripBase: true },
      })),
    }),
    dropOrtWasmFallbackAssets(),
  ],
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __APP_COMMIT__: JSON.stringify(commit()),
  },
  build: { target: "es2022", outDir: "dist", chunkSizeWarningLimit: 1200 },
});
