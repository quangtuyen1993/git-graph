export interface GraphNode {
  hash: string;
  abbreviatedHash: string;
  subject: string;
  author: string;
  authorDate: string;
  refs: string[];
  parents: string[];
  lane: number;        // X column (0-based)
  row: number;         // Y position (0-based, index in commit list)
  color: number;       // color index (0-9)
}

export interface GraphEdge {
  fromHash: string;
  toHash: string;
  fromRow: number;
  fromLane: number;
  toRow: number;
  toLane: number;
  color: number;       // same color as the branch it belongs to
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalRows: number;
  maxLane: number;     // widest point (number of parallel lanes)
}

export interface GraphWindow {
  nodes: GraphNode[];
  edges: GraphEdge[];
  startRow: number;
  endRow: number;
  totalRows: number;
  maxLane: number;
}

export interface GraphOptions {
  maxCount?: number;
  skip?: number;
  branch?: string;
  all?: boolean;
}
