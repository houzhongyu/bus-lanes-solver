import { expect, test } from "bun:test"
import { minimumLengthTargets, busLengthReports } from "../lib/route-lengths"
import type { SimpleRouteJson, Trace } from "../lib"

test("a two-tolerance range does not imply matching to the actual mean", () => {
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "a",
      connection_name: "a",
      route: [
        { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.1 },
        { route_type: "wire", x: 1, y: 0, layer: "top", width: 0.1 },
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "b",
      connection_name: "b",
      route: [
        { route_type: "wire", x: 0, y: 1, layer: "top", width: 0.1 },
        { route_type: "wire", x: 1, y: 1, layer: "top", width: 0.1 },
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "c",
      connection_name: "c",
      route: [
        { route_type: "wire", x: 0, y: 2, layer: "top", width: 0.1 },
        { route_type: "wire", x: 7, y: 2, layer: "top", width: 0.1 },
      ],
    },
  ]
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 10, minY: -1, maxY: 10 },
    obstacles: [],
    connections: traces.map((trace) => ({
      name: trace.connection_name!,
      pointsToConnect: trace.route as { x: number; y: number; layer: string }[],
    })),
    buses: [
      {
        busId: "data",
        connectionNames: ["a", "b", "c"],
        skewReference: "mean",
        maxLengthSkew: 3,
      },
    ],
  }
  expect(busLengthReports(input, traces)[0].skewMm).toBe(4)
  expect(busLengthReports(input, traces)[0].matched).toBe(false)
  const lengths = [...minimumLengthTargets(input, traces).values()]
  const mean =
    lengths.reduce((sum, lengthMm) => sum + lengthMm, 0) / lengths.length
  expect(
    Math.max(...lengths.map((lengthMm) => Math.abs(lengthMm - mean))),
  ).toBeLessThanOrEqual(3 + 1e-7)
  expect(lengths.reduce((sum, lengthMm) => sum + lengthMm, 0)).toBeCloseTo(
    12,
    6,
  )
  expect(minimumLengthTargets(input, traces).get("a")).toBeCloseTo(2.5, 6)
  expect(minimumLengthTargets(input, traces).get("b")).toBeCloseTo(2.5, 6)
})
