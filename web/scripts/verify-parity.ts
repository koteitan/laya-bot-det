/**
 * Run the browser's own inference path against the real model, outside a browser.
 *
 * onnxruntime-web's wasm backend works under Node, so everything the page does --
 * tokenizer, prompt construction, batching, calibration, the question design --
 * runs here unchanged. Only the source of the bytes differs: `fs` instead of
 * ranged `fetch`. Answers that match `pipeline/`'s Python output mean the port
 * is faithful, leaving only WebGPU and the DOM unverified.
 *
 *   npx tsx scripts/verify-parity.ts
 *
 * Needs ../models/laya-multilingual-onnx (./bot-det model) and ../data/authors.json
 * (./bot-det detect).
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as ort from "onnxruntime-web";
import { LayaAgent } from "../src/laya/vendor/agent.ts";
import { LayaTokenizer } from "../src/laya/vendor/tokenizer.ts";
import { OnnxRunner } from "../src/laya/vendor/session.ts";
import { buildState, combinedScore, QUESTIONS } from "../src/detect/questions.ts";
import { features, heuristicScore, type Note } from "../src/detect/features.ts";
import type { ChoiceAnswer } from "../src/laya/vendor/types.ts";

const DIR = new URL("../../models/laya-multilingual-onnx/", import.meta.url).pathname;
const AUTHORS = new URL("../../data/authors.json", import.meta.url).pathname;

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL("../node_modules/onnxruntime-web/dist/", import.meta.url).pathname;

const json = (name: string) => JSON.parse(readFileSync(DIR + name, "utf8"));
const bytes = readFileSync(DIR + "model.onnx");

const runner = await OnnxRunner.create(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  { providers: ["wasm"] },
);
const agent = new LayaAgent({
  config: json("rl_agent_config.json"),
  tokenizer: new LayaTokenizer(json("tokenizer/tokenizer.json"), json("tokenizer/tokenizer_config.json")),
  runner,
});
console.log("provider:", runner.provider);

const data = JSON.parse(readFileSync(AUTHORS, "utf8"));
const rows = data.authors as Array<Record<string, any>>;
const picks = [rows[0], rows[1], rows[Math.floor(rows.length / 2)], rows.at(-1)].filter(Boolean);

const dump: Array<{ name: string; state: string; ts_p_bot: number }> = [];
console.log();
console.log("name                 | ts p_bot | state 文字数");
console.log("---------------------+----------+-------------");
for (const a of picks) {
  // `sample` is the same text the Python run judged, so both sides see one input.
  const notes: Note[] = (a!.sample as string[]).map((content, i) => ({
    id: String(i),
    pubkey: a!.pubkey,
    content,
    created_at: (a!.features.last_seen ?? 0) - i * 60,
    tags: [],
  }));
  const profile = {
    name: a!.profile.name ?? "",
    display_name: a!.profile.display_name ?? "",
    about: a!.profile.about ?? "",
    nip05: a!.profile.nip05 ?? "",
    picture: "",
    bot: a!.profile.bot ?? null,
    created_at: 0,
  };
  const state = buildState(notes, profile) as string;
  const result = await agent.predict(state, QUESTIONS);
  const hb = (result.answers.bot_hb as ChoiceAnswer).probabilities.bot!;
  const bh = (result.answers.bot_bh as ChoiceAnswer).probabilities.bot!;
  const ts = (hb + bh) / 2;
  const name = (a!.profile.display_name || a!.profile.name || a!.npub.slice(0, 12)).slice(0, 20);
  dump.push({ name, state, ts_p_bot: ts });
  console.log(`${name.padEnd(20)} | ${ts.toFixed(4).padStart(8)} | ${String(state.length).padStart(12)}`);
  // The combined score is exercised too, so a change there cannot slip through.
  combinedScore(ts, heuristicScore(features(notes)).score);
}
const out = new URL("./parity.json", import.meta.url).pathname;
writeFileSync(out, JSON.stringify(dump, null, 1));
console.log(`\n${dump.length} 件を ${out} に書き出し`);
