import type { PCBPort } from "circuit-json"
import type { Terminal, Trace, Via } from "../../../lib/types"

type SourcePortId = PCBPort["source_port_id"]
type CopperNodeId = number
type CopperPoint = Pick<Terminal, "x" | "y" | "layer">
type CopperPort = Pick<Terminal, "x" | "y"> & {
  layers: NonNullable<Terminal["layers"]>
}
type CopperVia = Pick<Via, "x" | "y"> & {
  layers: NonNullable<Via["layers"]>
  pcb_trace_id: Trace["pcb_trace_id"]
}
interface CopperGraph {
  nodes: CopperPoint[]
  links: Map<CopperNodeId, number>[]
  segments: [CopperNodeId, CopperNodeId][]
  terminals: Map<SourcePortId, CopperNodeId>
}
const toleranceMm = 1e-6

function getOrAddCopperNode(
  point: CopperPoint,
  graph: CopperGraph,
): CopperNodeId {
  const found = graph.nodes.findIndex(
    (node) =>
      node.layer === point.layer &&
      Math.hypot(node.x - point.x, node.y - point.y) < toleranceMm,
  )
  if (found >= 0) return found
  graph.nodes.push(point)
  graph.links.push(new Map())
  return graph.nodes.length - 1
}

function connectCopperNodes(
  {
    from,
    to,
    lengthMm = 0,
  }: { from: CopperNodeId; to: CopperNodeId; lengthMm?: number },
  graph: CopperGraph,
): void {
  if (from === to) return
  graph.links[from].set(
    to,
    Math.min(graph.links[from].get(to) ?? Infinity, lengthMm),
  )
  graph.links[to].set(
    from,
    Math.min(graph.links[to].get(from) ?? Infinity, lengthMm),
  )
}

function addRouteNodes(routes: Trace[], graph: CopperGraph): void {
  for (const trace of routes) {
    let previous: CopperNodeId | undefined
    for (const point of trace.route) {
      if (point.route_type === "wire") {
        const current = getOrAddCopperNode(point, graph)
        if (
          previous !== undefined &&
          graph.nodes[previous].layer === point.layer
        )
          graph.segments.push([previous, current])
        previous = current
      } else if (point.route_type === "via") {
        const from = getOrAddCopperNode(
          { ...point, layer: point.from_layer },
          graph,
        )
        const to = getOrAddCopperNode(
          { ...point, layer: point.to_layer },
          graph,
        )
        // A via cannot bridge a missing lateral wire segment.
        if (
          previous !== undefined &&
          graph.nodes[previous].layer === point.from_layer &&
          Math.hypot(
            graph.nodes[previous].x - point.x,
            graph.nodes[previous].y - point.y,
          ) < toleranceMm
        )
          connectCopperNodes({ from: previous, to: from }, graph)
        connectCopperNodes({ from, to }, graph)
        previous = to
      }
    }
  }
}

function connectNodesAlongWires(graph: CopperGraph): void {
  // Split at real vertices, via locations and pad centers. Zero-cost links to
  // distant segment endpoints would incorrectly shorten a T-junction path.
  for (const [from, to] of graph.segments) {
    const start = graph.nodes[from],
      end = graph.nodes[to]
    const dx = end.x - start.x,
      dy = end.y - start.y
    const squaredLengthMm2 = dx * dx + dy * dy
    if (!squaredLengthMm2) continue
    const onSegment: { node: CopperNodeId; fraction: number }[] = []
    for (const [node, point] of graph.nodes.entries()) {
      if (point.layer !== start.layer) continue
      const fraction = Math.max(
        0,
        Math.min(
          1,
          ((point.x - start.x) * dx + (point.y - start.y) * dy) /
            squaredLengthMm2,
        ),
      )
      if (
        Math.hypot(
          point.x - start.x - fraction * dx,
          point.y - start.y - fraction * dy,
        ) < toleranceMm
      )
        onSegment.push({ node, fraction })
    }
    onSegment.sort((left, right) => left.fraction - right.fraction)
    for (let index = 1; index < onSegment.length; index++)
      connectCopperNodes(
        {
          from: onSegment[index - 1].node,
          to: onSegment[index].node,
          lengthMm:
            (onSegment[index].fraction - onSegment[index - 1].fraction) *
            Math.sqrt(squaredLengthMm2),
        },
        graph,
      )
  }
}

function shortestCopperPathLength(
  {
    start,
    end,
  }: { start: CopperNodeId | undefined; end: CopperNodeId | undefined },
  graph: CopperGraph,
): number | null {
  if (start === undefined || end === undefined) return null
  const distances = graph.nodes.map(() => Infinity)
  const visited = new Set<CopperNodeId>()
  distances[start] = 0
  while (true) {
    let current: CopperNodeId = -1
    for (let node = 0; node < graph.nodes.length; node++)
      if (
        !visited.has(node) &&
        Number.isFinite(distances[node]) &&
        (current < 0 || distances[node] < distances[current])
      )
        current = node
    if (current < 0) return null
    if (current === end) return distances[current]
    visited.add(current)
    for (const [next, lengthMm] of graph.links[current])
      distances[next] = Math.min(distances[next], distances[current] + lengthMm)
  }
}

/** Independent shortest copper paths in board-world mm: +X right, +Y up,
 * +Z above, right handed. Vias have zero planar length. All supplied routes,
 * ports and vias belong to one electrical net; branch stubs add no path length. */
export function createCopperPathMeasurer({
  routes,
  ports,
  vias,
}: {
  routes: Trace[]
  ports: ReadonlyMap<SourcePortId, CopperPort>
  vias: CopperVia[]
}): (from: SourcePortId, to: SourcePortId) => number | null {
  if (!routes.length) return () => null
  const graph: CopperGraph = {
    nodes: [],
    links: [],
    segments: [],
    terminals: new Map(),
  }
  addRouteNodes(routes, graph)
  const routeIds = new Set(routes.map((trace) => trace.pcb_trace_id))
  for (const via of vias) {
    if (!routeIds.has(via.pcb_trace_id)) continue
    const viaNodes = via.layers.map((layer) =>
      getOrAddCopperNode({ x: via.x, y: via.y, layer }, graph),
    )
    for (const node of viaNodes)
      connectCopperNodes({ from: viaNodes[0], to: node }, graph)
  }
  for (const [sourcePortId, port] of ports) {
    const portNodes = port.layers.map((layer) =>
      getOrAddCopperNode({ ...port, layer }, graph),
    )
    if (!portNodes.length) continue
    for (const node of portNodes)
      connectCopperNodes({ from: portNodes[0], to: node }, graph)
    graph.terminals.set(sourcePortId, portNodes[0])
  }
  connectNodesAlongWires(graph)
  return (from, to) =>
    shortestCopperPathLength(
      {
        start: graph.terminals.get(from),
        end: graph.terminals.get(to),
      },
      graph,
    )
}
