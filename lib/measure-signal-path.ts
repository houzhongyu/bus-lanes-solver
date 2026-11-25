import {
  getCopperLayerNames,
  getRouteViaSpanLayers,
} from "@tscircuit/fanout-solver"
import { getSegmentIntersection } from "@tscircuit/math-utils"
import { distance, pointSegmentDistanceToPoints } from "./geometry"
import { MinHeap } from "./min-heap"
import type {
  ConnectionName,
  SimpleRouteJson,
  Terminal,
  Trace,
  Wire,
} from "./types"

type CopperNodeId = number
interface CopperGraph {
  points: Terminal[]
  links: Map<CopperNodeId, number>[]
}

function copperNode(graph: CopperGraph, point: Terminal): CopperNodeId {
  const found = graph.points.findIndex(
    (other) => other.layer === point.layer && distance(other, point) < 1e-8,
  )
  if (found >= 0) return found
  graph.points.push(point)
  graph.links.push(new Map())
  return graph.points.length - 1
}

function connectCopper(
  graph: CopperGraph,
  a: CopperNodeId,
  b: CopperNodeId,
  lengthMm: number,
): void {
  if (a === b) return
  graph.links[a].set(b, Math.min(graph.links[a].get(b) ?? Infinity, lengthMm))
  graph.links[b].set(a, Math.min(graph.links[b].get(a) ?? Infinity, lengthMm))
}

/** Shortest connected pad-to-pad centerline in board-world mm (+X right,
 * +Y up). Branch stubs do not add path length. Vias connect their manufactured
 * layers with zero planar length; stackup delay is not inferred. */
export function measureSignalPath({
  input,
  traces,
  connectionName,
  from,
  to,
}: {
  input: SimpleRouteJson
  traces: Trace[]
  connectionName: ConnectionName
  from: Terminal
  to: Terminal
}): number | null {
  const graph: CopperGraph = { points: [], links: [] }
  const segments: [Wire, Wire][] = []
  const physicalLayers = getCopperLayerNames(input.layerCount)
  const sourceTraceId = input.connections.find(
    (connection) => connection.name === connectionName,
  )?.source_trace_id
  for (const trace of traces) {
    if (
      trace.connection_name !== connectionName &&
      trace.source_trace_id !== connectionName &&
      (!sourceTraceId || trace.source_trace_id !== sourceTraceId)
    )
      continue
    for (const [index, point] of trace.route.entries()) {
      if (point.route_type === "via") {
        const span = getRouteViaSpanLayers({
          fromLayer: point.from_layer,
          toLayer: point.to_layer,
          layers: point.layers,
          layerNames: physicalLayers,
          allowBlindAndBuriedVias: input.allowBlindAndBuriedVias ?? false,
        })
        const nodes = span.map((layer) =>
          copperNode(graph, { ...point, layer }),
        )
        for (const node of nodes.slice(1))
          connectCopper(graph, nodes[0], node, 0)
        continue
      }
      copperNode(graph, point)
      const previous = trace.route[index - 1]
      if (previous?.route_type === "wire" && previous.layer === point.layer)
        segments.push([previous, point])
    }
  }
  const start = copperNode(graph, from)
  const end = copperNode(graph, to)
  // Real T junctions and same-net crossings split both wires at their actual
  // intersection. A zero-cost link to a remote segment endpoint would shorten it.
  for (const [index, [a, b]] of segments.entries()) {
    for (const [c, d] of segments.slice(index + 1)) {
      if (a.layer !== c.layer) continue
      const intersection = getSegmentIntersection(a, b, c, d)
      if (intersection) copperNode(graph, { ...intersection, layer: a.layer })
    }
  }
  for (const [a, b] of segments) {
    const span = distance(a, b)
    if (span < 1e-8) continue
    const onSegment: CopperNodeId[] = []
    for (const [node, point] of graph.points.entries()) {
      if (
        point.layer === a.layer &&
        pointSegmentDistanceToPoints(point, a, b) < 1e-8
      )
        onSegment.push(node)
    }
    onSegment.sort(
      (left, right) =>
        distance(a, graph.points[left]) - distance(a, graph.points[right]),
    )
    for (let index = 1; index < onSegment.length; index++) {
      const first = onSegment[index - 1]
      const second = onSegment[index]
      connectCopper(
        graph,
        first,
        second,
        distance(graph.points[first], graph.points[second]),
      )
    }
  }
  const queue = new MinHeap<{ node: CopperNodeId; f: number }>()
  const shortest = new Map<CopperNodeId, number>([[start, 0]])
  queue.push({ node: start, f: 0 })
  while (queue.length) {
    const current = queue.pop()
    if (current.f !== shortest.get(current.node)) continue
    if (current.node === end) return current.f
    for (const [next, lengthMm] of graph.links[current.node]) {
      const candidate = current.f + lengthMm
      if (candidate >= (shortest.get(next) ?? Infinity)) continue
      shortest.set(next, candidate)
      queue.push({ node: next, f: candidate })
    }
  }
  return null
}
