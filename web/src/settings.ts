import { BOT_THRESHOLD } from "./detect/questions.ts";

export interface Settings {
  dark: boolean;
  threshold: number;
  sort: "score" | "posts" | "recent";
  filter: "all" | "bot" | "human" | "labelled" | "unjudged";
  seed: boolean;
}

const KEY = "laya-bot-det:ui";

export const DEFAULTS: Settings = {
  dark: true,
  threshold: BOT_THRESHOLD,
  sort: "score",
  filter: "all",
  seed: true,
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
