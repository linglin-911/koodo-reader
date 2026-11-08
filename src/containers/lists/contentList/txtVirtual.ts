export const TXT_ROW_HEIGHT = 40;
export const TXT_OVERSCAN = 6;
export const txtVirtualRange = (count: number, scrollTop: number, height: number) => {
  const first = Math.min(Math.max(0, count - 1), Math.floor(Math.max(0, scrollTop) / TXT_ROW_HEIGHT));
  const start = Math.max(0, first - TXT_OVERSCAN);
  const end = Math.min(count, first + Math.ceil(height / TXT_ROW_HEIGHT) + TXT_OVERSCAN + 1);
  return { start, end, totalHeight: count * TXT_ROW_HEIGHT };
};
export const txtScrollToIndex = (index: number, count: number, height: number) =>
  Math.max(0, Math.min(Math.max(0, count * TXT_ROW_HEIGHT - height),
    index * TXT_ROW_HEIGHT + TXT_ROW_HEIGHT / 2 - height / 2));
