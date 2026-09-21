/** Fetch a split bundle from a live host and check it rejoins to the original.
 *
 *  Mirrors what `download.ts` does in the browser: read the manifest, pull each
 *  part, concatenate, compare the sha256 against what the manifest claims. It
 *  also reports whether the host honours Range, because GitHub Pages does not,
 *  and a loader that assumes it would fetch the whole file per 8 MB chunk.
 *
 *   npx tsx scripts/verify-split-host.ts https://koteitan.github.io/laya-int8/
 */
import { createHash } from "node:crypto";

const base = (process.argv[2] ?? "").replace(/\/?$/, "/");
if (!base.startsWith("https://")) {
  console.error("usage: verify-split-host.ts <https base url>");
  process.exit(1);
}

const probe = await fetch(base + "model.onnx.000", { headers: { Range: "bytes=0-0" } });
console.log(`Range: HTTP ${probe.status} -> ${probe.status === 206 ? "対応" : "非対応（丸ごと取得に切替）"}`);
console.log(`CORS : ${probe.headers.get("access-control-allow-origin") ?? "なし"}`);

const manifest = (await (await fetch(base + "model.onnx.parts.json")).json()) as {
  size: number;
  sha256: string;
  parts: { name: string; size: number }[];
};
console.log(`\nmanifest: ${manifest.parts.length} parts, ${(manifest.size / 1e6).toFixed(0)} MB`);

const bytes = new Uint8Array(manifest.size);
let written = 0;
for (const part of manifest.parts) {
  const buf = await (await fetch(base + part.name)).arrayBuffer();
  if (buf.byteLength !== part.size) {
    console.error(`  ${part.name}: ${buf.byteLength} bytes, expected ${part.size}`);
    process.exit(1);
  }
  bytes.set(new Uint8Array(buf), written);
  written += buf.byteLength;
  console.log(`  ${part.name}  ${(buf.byteLength / 1e6).toFixed(1)} MB  累計 ${(written / 1e6).toFixed(0)} MB`);
}

const sha = createHash("sha256").update(bytes).digest("hex");
console.log(`\n組み直し: ${written} / ${manifest.size} bytes`);
console.log(`sha256   : ${sha}`);
console.log(`manifest : ${manifest.sha256}`);
console.log(sha === manifest.sha256 && written === manifest.size ? "一致" : "不一致");
