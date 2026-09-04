export interface PdfTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  hasEOL: boolean;
}

/**
 * Rebuild reading order from pdf.js items: cluster by visual row, then left to
 * right. Concatenating `str` in array order jumbles title-block stamps.
 */
export function reconstructPageText(items: readonly PdfTextItem[]): string {
  const meaningful = items.filter((item) => item.str.trim().length > 0);
  if (meaningful.length === 0) return "";
  const sorted = [...meaningful].sort((left, right) => {
    const rowHeight = Math.max(left.height, right.height, 8);
    const dy = right.y - left.y;
    if (Math.abs(dy) > rowHeight * 0.55) return dy;
    return left.x - right.x;
  });
  const lines: string[] = [];
  let current: PdfTextItem[] = [];
  for (const item of sorted) {
    const last = current.at(-1);
    if (last === undefined) {
      current = [item];
      continue;
    }
    const rowHeight = Math.max(last.height, item.height, 8);
    if (Math.abs(last.y - item.y) > rowHeight * 0.55) {
      lines.push(joinLine(current));
      current = [item];
      continue;
    }
    current.push(item);
    if (item.hasEOL) {
      lines.push(joinLine(current));
      current = [];
    }
  }
  if (current.length > 0) lines.push(joinLine(current));
  return lines.filter((line) => line.length > 0).join("\n");
}

function joinLine(items: readonly PdfTextItem[]): string {
  const ordered = [...items].sort((left, right) => left.x - right.x);
  let line = "";
  let previous: PdfTextItem | undefined;
  for (const item of ordered) {
    const piece = item.str.replace(/\s+/g, " ");
    if (previous === undefined) {
      line = piece;
      previous = item;
      continue;
    }
    const gap = item.x - (previous.x + previous.width);
    const space = gap > Math.max(previous.height, item.height, 4) * 0.25 ? " " : "";
    line += `${space}${piece}`;
    previous = item;
  }
  return line.trim();
}
