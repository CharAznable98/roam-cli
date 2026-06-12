export type LayoutMode = "mobile" | "tablet" | "desktop";

export function getLayoutMode(width: number): LayoutMode {
  if (width >= 1440) {
    return "desktop";
  }

  if (width >= 768) {
    return "tablet";
  }

  return "mobile";
}
