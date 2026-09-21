/** Whether this device can hold the model, and what to say when it cannot.
 *
 *  Loading peaks at roughly twice the model size. `downloadBytes` assembles the
 *  647 MB file in one JS ArrayBuffer, and `InferenceSession.create` copies it
 *  into the wasm heap before the original can be released -- both are live at
 *  the same moment, so the floor is about 1.3 GB plus the parsed tokenizer and
 *  whatever WebGPU allocates.
 *
 *  That is above what mobile Safari gives a tab. It does not return an error;
 *  it kills the tab, which the browser reports as "a problem repeatedly
 *  occurred". Since there is nothing to catch, the only useful thing is to say
 *  so before someone spends 681 MB of bandwidth finding out.
 */

export const PEAK_BYTES = 1_300_000_000;

/** iOS and iPadOS run every browser on WebKit with the same per-tab ceiling, so
 *  this is about the platform, not the app the person chose. */
function isIOS(): boolean {
  const ua = navigator.userAgent;
  if (/iPhone|iPod/.test(ua)) return true;
  // iPadOS reports itself as a Mac; touch points tell the two apart.
  return /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** Chrome and Edge expose this, rounded down to 0.25/0.5/1/2/4/8. Safari does not. */
function deviceMemoryGb(): number | null {
  const value = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof value === "number" ? value : null;
}

export interface Warning {
  /** True when loading is expected to kill the tab rather than merely be slow. */
  fatal: boolean;
  text: string;
}

export function memoryWarning(): Warning | null {
  if (isIOS()) {
    return {
      fatal: true,
      text:
        "この端末（WebKit）では読み込めません。ダウンロードは通りますが、" +
        "モデルを展開する InferenceSession.create の中でタブが落ちます" +
        "（「問題が繰り返し起きました」の画面）。原因は調査中で、" +
        "端末のメモリ量ではないことまでは分かっています。" +
        "統計のみでの判定はそのまま使えます。",
    };
  }
  const gb = deviceMemoryGb();
  if (gb !== null && gb < 4) {
    return {
      fatal: true,
      text:
        `この端末の搭載メモリは約 ${gb} GB です。モデルの展開に 1.3 GB 前後を使うため、` +
        "読み込み中にタブが落ちる可能性が高いです。",
    };
  }
  if (gb !== null && gb < 8) {
    return {
      fatal: false,
      text: `搭載メモリ約 ${gb} GB。読み込み中に 1.3 GB 前後を使うので、他のタブは閉じてください。`,
    };
  }
  return null;
}
