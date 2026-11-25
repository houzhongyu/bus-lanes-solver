import {
  getCopperLayerNames,
  getRouteViaSpanLayers,
} from "@tscircuit/fanout-solver"
import { getSegmentIntersection } from "@tscircuit/math-utils"
import { distance, pointSegmentDistanceToPoints } from "./geometry"
import { MinHeap } from "./min-heap"
import type {
  BusLengthMatchingPath,
  ConnectionName,
  SimpleRouteJson,
  Terminal,
  Trace,
  Wire,
} from "./types"

/** Completed references may no longer have an active routing connection. */
export function getSignalPathEndpoints({
  input,
  path,
}: {
  input: SimpleRouteJson
  path: BusLengthMatchingPath
}): { connectionName: ConnectionName; from: Terminal; to: Terminal } {
  if (path.from && path.to)
    return { connectionName: path.connectionName, from: path.from, to: path.to }
  const connection = input.connections.find(
    (member) => member.name === path.connectionName,
  )
  const from = connection?.pointsToConnect.find(
    (point) => point.pcb_port_id === path.pcbPortIds?.[0],
  )
  const to = connection?.pointsToConnect.find(
    (point) => point.pcb_port_id === path.pcbPortIds?.[1],
  )
  if (!from || !to || from === to)
    throw Error("Timing path endpoints must belong to the routed connection")
  return { connectionName: path.connectionName, from, to }
}

type CopperNodeId = number
interface CopperGraph {
  points: Terminal[]
  links: Map<CopperNodeId, number>[]
}

function getOrAddCopperNode(graph: CopperGraph, point: Terminal): CopperNodeId {
  const found = graph.points.findIndex(
    (other) => other.layer === point.layer && distance(other, point) < 1e-8,
  )
  if (found >= 0) return found
  graph.points.push(point)
  graph.links.push(new Map())
  return graph.points.length - 1
}

function connectCopper({
  graph,
  fromNode,
  toNode,
  lengthMm,
}: {
  graph: CopperGraph
  fromNode: CopperNodeId
  toNode: CopperNodeId
  lengthMm: number
}): void {
  if (fromNode === toNode) return
  graph.links[fromNode].set(
    toNode,
    Math.min(graph.links[fromNode].get(toNode) ?? Infinity, lengthMm),
  )
  graph.links[toNode].set(
    fromNode,
    Math.min(graph.links[toNode].get(fromNode) ?? Infinity, lengthMm),
  )
}

type CopperWireSegment = [Wire, Wire]

function addTraceCopper({
  input,
  traces,
  connectionName,
  graph,
}: {
  input: SimpleRouteJson
  traces: Trace[]
  connectionName: ConnectionName
  graph: CopperGraph
}): CopperWireSegment[] {
  const segments: CopperWireSegment[] = []
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
          getOrAddCopperNode(graph, { ...point, layer }),
        )
        for (const node of nodes.slice(1))
          connectCopper({
            graph,
            fromNode: nodes[0],
            toNode: node,
            lengthMm: 0,
          })
        continue
      }
      getOrAddCopperNode(graph, point)
      const previous = trace.route[index - 1]
      if (previous?.route_type === "wire" && previous.layer === point.layer)
        segments.push([previous, point])
    }
  }
  return segments
}

function connectWireCopper(
  graph: CopperGraph,
  segments: CopperWireSegment[],
): void {
  // Real T junctions and same-net crossings split both wires at their actual
  // intersection. A zero-cost link to a remote segment endpoint would shorten it.
  for (const [index, [a, b]] of segments.entries()) {
    for (const [c, d] of segments.slice(index + 1)) {
      if (a.layer !== c.layer) continue
      const intersection = getSegmentIntersection(a, b, c, d)
      if (intersection)
        getOrAddCopperNode(graph, { ...intersection, layer: a.layer })
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
      connectCopper({
        graph,
        fromNode: first,
        toNode: second,
        lengthMm: distance(graph.points[first], graph.points[second]),
      })
    }
  }
}

function shortestCopperPathLength({
  graph,
  start,
  end,
}: {
  graph: CopperGraph
  start: CopperNodeId
  end: CopperNodeId
}): number | null {
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

/** Shortest connected pad-to-pad centerline in board-world mm, right-handed:
 * +X right, +Y up, +Z toward the top layer. Branch stubs add no path length.
 * Vias join manufactured layers with zero planar length; delay is not inferred. */
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
  const segments = addTraceCopper({ input, traces, connectionName, graph })
  const start = getOrAddCopperNode(graph, from)
  const end = getOrAddCopperNode(graph, to)
  connectWireCopper(graph, segments)
  return shortestCopperPathLength({ graph, start, end })
}
