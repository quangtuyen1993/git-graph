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
