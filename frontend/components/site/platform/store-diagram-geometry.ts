// Hand-built geometry for the W/R diagram. Two layouts of the same graph: "wide" for large screens and "tall" for
// narrow ones, so labels stay legible without scaling a landscape drawing down to phone width.
export type NodeId = "clients" | "api" | "w" | "r" | "engine";
export type FlowId = "writes" | "reads" | "replication";
export type Tone = "write" | "read" | "link";
type Dir = "up" | "down" | "left" | "right";

export interface NodeBox {
  id: NodeId;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Line {
  id: string;
  /** Path of the line. Drawn in with stroke-dashoffset. */
  d: string;
  /** Arrow head at the end of the path. */
  head: string;
  tone: Tone;
}
export interface FlowLabel {
  flow: FlowId;
  x: number;
  y: number;
  anchor: "start" | "middle" | "end";
  tone: Tone;
}
export interface Layout {
  width: number;
  height: number;
  nodes: readonly NodeBox[];
  lines: readonly Line[];
  labels: readonly FlowLabel[];
}

/** Open arrow head whose tip is at (x, y) and which points in `dir`. */
function head(x: number, y: number, dir: Dir): string {
  const s = 8;
  const k = 5.5;
  switch (dir) {
    case "right":
      return `M${x - s} ${y - k}L${x} ${y}L${x - s} ${y + k}`;
    case "left":
      return `M${x + s} ${y - k}L${x} ${y}L${x + s} ${y + k}`;
    case "down":
      return `M${x - k} ${y - s}L${x} ${y}L${x + k} ${y - s}`;
    case "up":
      return `M${x - k} ${y + s}L${x} ${y}L${x + k} ${y + s}`;
  }
}

export const WIDE: Layout = {
  width: 1000,
  height: 440,
  nodes: [
    { id: "clients", x: 20, y: 170, w: 160, h: 100 },
    { id: "api", x: 280, y: 170, w: 170, h: 100 },
    { id: "w", x: 600, y: 30, w: 220, h: 120 },
    { id: "r", x: 600, y: 290, w: 220, h: 120 },
    { id: "engine", x: 850, y: 170, w: 140, h: 100 },
  ],
  lines: [
    { id: "clients-api", d: "M180 220H280", head: head(280, 220, "right"), tone: "link" },
    { id: "api-w", d: "M450 200H525V90H600", head: head(600, 90, "right"), tone: "write" },
    { id: "r-api", d: "M600 350H500V240H450", head: head(450, 240, "left"), tone: "read" },
    { id: "w-r", d: "M710 150V290", head: head(710, 290, "down"), tone: "link" },
    { id: "engine-w", d: "M920 170V90H820", head: head(820, 90, "left"), tone: "write" },
    { id: "r-engine", d: "M820 350H920V270", head: head(920, 270, "up"), tone: "read" },
  ],
  labels: [
    { flow: "writes", x: 535, y: 150, anchor: "start", tone: "write" },
    { flow: "reads", x: 510, y: 322, anchor: "start", tone: "read" },
    { flow: "replication", x: 722, y: 226, anchor: "start", tone: "link" },
    { flow: "writes", x: 870, y: 78, anchor: "middle", tone: "write" },
    { flow: "reads", x: 870, y: 372, anchor: "middle", tone: "read" },
  ],
};

export const TALL: Layout = {
  width: 420,
  height: 700,
  nodes: [
    { id: "clients", x: 110, y: 10, w: 200, h: 70 },
    { id: "api", x: 110, y: 150, w: 200, h: 80 },
    { id: "w", x: 10, y: 330, w: 150, h: 100 },
    { id: "r", x: 260, y: 330, w: 150, h: 100 },
    { id: "engine", x: 110, y: 560, w: 200, h: 80 },
  ],
  lines: [
    { id: "clients-api", d: "M210 80V150", head: head(210, 150, "down"), tone: "link" },
    { id: "api-w", d: "M130 230V280H85V330", head: head(85, 330, "down"), tone: "write" },
    { id: "r-api", d: "M335 330V280H290V230", head: head(290, 230, "up"), tone: "read" },
    { id: "w-r", d: "M160 380H260", head: head(260, 380, "right"), tone: "link" },
    { id: "engine-w", d: "M130 560V500H85V430", head: head(85, 430, "up"), tone: "write" },
    { id: "r-engine", d: "M335 430V500H290V560", head: head(290, 560, "down"), tone: "read" },
  ],
  labels: [
    { flow: "writes", x: 75, y: 312, anchor: "end", tone: "write" },
    { flow: "reads", x: 345, y: 312, anchor: "start", tone: "read" },
    { flow: "replication", x: 210, y: 368, anchor: "middle", tone: "link" },
    { flow: "writes", x: 75, y: 472, anchor: "end", tone: "write" },
    { flow: "reads", x: 345, y: 472, anchor: "start", tone: "read" },
  ],
};
