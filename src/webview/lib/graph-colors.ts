// 10 distinct colors that work in both dark and light themes
export const BRANCH_COLORS = [
  '#4ec9b0', // teal
  '#569cd6', // blue
  '#c586c0', // purple
  '#ce9178', // orange
  '#6a9955', // green
  '#d7ba7d', // gold
  '#9cdcfe', // light blue
  '#f44747', // red
  '#b5cea8', // lime
  '#dcdcaa', // yellow
];

export function getColor(index: number): string {
  return BRANCH_COLORS[index % BRANCH_COLORS.length];
}

/** Returns the branch colour as an "r, g, b" triplet for use in rgba(). */
export function getColorRgb(index: number): string {
  const hex = getColor(index);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `${r}, ${g}, ${b}`;
}
