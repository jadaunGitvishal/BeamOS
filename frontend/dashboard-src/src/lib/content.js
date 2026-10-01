import { cCol } from "./format";

export const WEAK_BELOW = 75;

export const contentLabel = (c) => c.content_name || "Unnamed content";

export function summarizeContent(content) {
  const list = content || [];
  const plays = list.reduce((a, c) => a + c.plays, 0);
  const completed = list.reduce((a, c) => a + (c.completed_plays || 0), 0);
  const seconds = list.reduce((a, c) => a + (c.total_seconds || 0), 0);
  const pct = plays ? Math.round((completed / plays) * 1000) / 10 : null;
  const weak = list.filter((c) => c.completion_pct !== null && c.completion_pct < WEAK_BELOW);
  return {
    items: list.length,
    plays,
    completed,
    incomplete: plays - completed,
    seconds,
    pct,
    weak: weak.length,
    weakPlays: weak.reduce((a, c) => a + c.plays, 0),
    color: pct === null ? "var(--line)" : cCol(pct),
  };
}
