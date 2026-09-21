import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { ErrorBoundary } from "./ui/ErrorBoundary.tsx";
import "./styles.css";

const root = document.getElementById("root")!;

/**
 * `?reset` wipes this origin's storage and stops, without mounting the app.
 *
 * The model cache can reach 681 MB, and a device that cannot hold the model has
 * already had a tab killed mid-write by the time anyone wants to clear it.
 * Clearing from the app's own button is no help then -- the app is what will not
 * start. This path runs before React and touches nothing else, so it works even
 * when everything after it does not.
 */
async function reset(): Promise<void> {
  const done: string[] = [];
  try {
    if (typeof caches !== "undefined") {
      for (const name of await caches.keys()) {
        await caches.delete(name);
        done.push(name);
      }
    }
  } catch (error) {
    done.push(`caches: ${String(error)}`);
  }
  try {
    localStorage.clear();
    done.push("localStorage");
  } catch {
    // Blocked storage has nothing to clear.
  }
  root.innerHTML =
    `<div style="padding:24px;font-family:system-ui;line-height:1.8">` +
    `<h1 style="font-size:18px">消しました</h1>` +
    `<p>${done.length ? done.map((d) => `<code>${d}</code>`).join(", ") : "消すものがありませんでした"}</p>` +
    `<p><a href="./">戻る</a></p></div>`;
}

if (new URLSearchParams(location.search).has("reset")) {
  void reset();
} else {
  createRoot(root).render(
    <StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </StrictMode>,
  );
}
