/** How long InferenceSession.create takes, per model size.
 *
 *  Memory turned out not to be the constraint on iPhone: contiguous
 *  ArrayBuffers to 1.3 GB and a 775 MB WebAssembly.Memory both allocate fine,
 *  and forcing the CPU backend crashed just the same. What is left is time --
 *  iOS kills a tab that holds the main thread too long, and parsing plus
 *  optimising a 647 MB graph is exactly that kind of work.
 */
import { readFileSync } from "node:fs";
import * as ort from "onnxruntime-web";

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL("../node_modules/onnxruntime-web/dist/", import.meta.url).pathname;

const models: [string, string][] = [
  ["fp16", "laya-multilingual-onnx/model.onnx"],
  ["int8", "laya-multilingual-onnx-int8/model.onnx"],
];

for (const [name, file] of models) {
  const path = new URL("../../models/" + file, import.meta.url).pathname;
  const buf = readFileSync(path);
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
  for (const level of ["all", "basic"] as const) {
    const started = Date.now();
    await ort.InferenceSession.create(bytes, {
      executionProviders: ["wasm"],
      graphOptimizationLevel: level,
    });
    const secs = (Date.now() - started) / 1000;
    console.log(
      `${name}  ${(buf.length / 1e6).toFixed(0).padStart(4)} MB  opt=${level.padEnd(5)}` +
        `  create: ${secs.toFixed(1).padStart(6)} 秒   スマホ目安(×5): ${(secs * 5).toFixed(0).padStart(4)} 秒`,
    );
  }
}
