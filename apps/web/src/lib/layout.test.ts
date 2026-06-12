import { describe, expect, it } from "vitest";
import { getLayoutMode } from "./layout";

describe("layout breakpoints", () => {
  it("maps widths to mobile, tablet, and desktop", () => {
    expect(getLayoutMode(375)).toBe("mobile");
    expect(getLayoutMode(768)).toBe("tablet");
    expect(getLayoutMode(1180)).toBe("tablet");
    expect(getLayoutMode(1440)).toBe("desktop");
  });
});
