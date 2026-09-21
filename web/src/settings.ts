import { BOT_THRESHOLD } from "./detect/questions.ts";

export interface Settings {
  dark: boolean;
  threshold: number;
  sort: "score" | "laya" | "heuristic" | "posts" | "recent";
  filter: "all" | "bot" | "human" | "labelled" | "disagree";
  seed: boolean;
  showPosts: boolean;
}

const KEY = "laya-bot-det:ui";

export const DEFAULTS: Settings = {
  dark: true,
  threshold: BOT_THRESHOLD,
  sort: "score",
  filter: "all",
  seed: true,
  showPosts: true,
};

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private mode or blocked storage: the session still works, it just forgets.
  }
}
