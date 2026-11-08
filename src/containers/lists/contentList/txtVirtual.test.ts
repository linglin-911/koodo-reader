import { expect, it } from "vitest";
import { TXT_ROW_HEIGHT, txtScrollToIndex, txtVirtualRange } from "./txtVirtual";
it("keeps the viewport and overscan bounded at both ends and deep in 7700 chapters", () => {
  for (const height of [0, 300, 600, 4000]) for (const index of [0, 499, 6799, 7699]) {
    const top = txtScrollToIndex(index, 7700, height);
    const range = txtVirtualRange(7700, top, height);
    expect(range.start).toBeLessThanOrEqual(index);
    expect(range.end).toBeGreaterThan(index);
    expect(range.end - range.start).toBeLessThanOrEqual(120);
    expect(range.totalHeight).toBe(7700 * TXT_ROW_HEIGHT);
  }
  expect(txtVirtualRange(0, 0, 600)).toEqual({ start: 0, end: 0, totalHeight: 0 });
  expect(txtVirtualRange(2, 99999, 600)).toEqual({ start: 0, end: 2, totalHeight: 80 });
  expect(txtScrollToIndex(6799, 1, 600)).toBe(0);
});
