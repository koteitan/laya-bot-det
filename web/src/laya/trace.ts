/** Breadcrumbs that survive the tab being killed.
 *
 *  The failure takes the page down, so console output, in-memory state and any
 *  error handler all go with it. localStorage does not: it is written
 *  synchronously and is still there on the next visit. Writing one line per step
 *  before each step turns "it crashed somewhere" into "it got this far and no
 *  further", which is the only way to find the wall when every hypothesis so far
 *  has measured fine in isolation.
 *
 *  Kept deliberately small and synchronous. Anything clever here risks being the
 *  thing that fails.
 */

const KEY = "laya-bot-det:trace";
const MAX = 60;

export interface Mark {
  t: number;
  step: string;
  note?: string;
}

function read(): Mark[] {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Mark[]) : [];
  } catch {
    return [];
  }
}

export function mark(step: string, note?: string): void {
  try {
    const marks = read();
    marks.push({ t: Date.now(), step, ...(note ? { note } : {}) });
    localStorage.setItem(KEY, JSON.stringify(marks.slice(-MAX)));
  } catch {
    // Storage blocked: the run still works, it just leaves no trail.
  }
}

export const trace = (): Mark[] => read();

export function clearTrace(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}

/** True when a previous run left marks without reaching the end. */
export function crashed(): boolean {
  const marks = read();
  return marks.length > 0 && marks[marks.length - 1]!.step !== "done";
}

/** Readable, oldest first, with the gap from the previous mark. */
export function format(marks: Mark[] = read()): string {
  if (!marks.length) return "";
  const start = marks[0]!.t;
  return marks
    .map((m, i) => {
      const since = i ? m.t - marks[i - 1]!.t : 0;
      return `+${((m.t - start) / 1000).toFixed(1)}s (${(since / 1000).toFixed(1)}s) ${m.step}` +
        (m.note ? ` — ${m.note}` : "");
    })
    .join("\n");
}

/** Record what a global failure looked like, for handlers installed at startup. */
export function installGlobalHandlers(): void {
  addEventListener("error", (e) => mark("window.error", `${e.message} @ ${e.filename}:${e.lineno}`));
  addEventListener("unhandledrejection", (e) =>
    mark("unhandledrejection", String((e as PromiseRejectionEvent).reason).slice(0, 200)),
  );
}
