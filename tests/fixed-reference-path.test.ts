import { expect, test } from "bun:test"
import { fixedRouteLength, minimumLengthTargets } from "../lib/route-lengths"
import type { SimpleRouteJson, Trace } from "../lib"

test("a fixed clock reference excludes its termination stub and cannot be lengthened", () => {
  const data: Trace = {
    type: "pcb_trace",
    pcb_trace_id: "data",
    connection_name: "data",
    route: [
      { route_type: "wire", x: 0, y: -2, layer: "top", width: 0.1 },
      { route_type: "wire", x: 1, y: -2, layer: "top", width: 0.1 },
    ],
  }
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -1, maxX: 12, minY: -3, maxY: 22 },
    obstacles: [],
    connections: [
      {
        name: "data",
        pointsToConnect: [
          { x: 0, y: -2, layer: "top" },
          { x: 1, y: -2, layer: "top" },
        ],
      },
    ],
    traces: [
      {
        type: "pcb_trace",
        pcb_trace_id: "clock",
        connection_name: "clock",
        route: [
          { route_type: "wire", x: 0, y: 0, layer: "top", width: 0.1 },
          { route_type: "wire", x: 10, y: 0, layer: "top", width: 0.1 },
        ],
      },
      {
        type: "pcb_trace",
        pcb_trace_id: "termination",
        connection_name: "clock",
        route: [
          { route_type: "wire", x: 5, y: 0, layer: "top", width: 0.1 },
          { route_type: "wire", x: 5, y: 20, layer: "top", width: 0.1 },
        ],
      },
    ],
    buses: [
      {
        busId: "data_to_clock",
        connectionNames: ["data"],
        referenceConnectionNames: ["clock"],
        skewReference: "references",
        maxLengthSkew: 2,
        lengthMatchingPaths: [
          {
            connectionName: "clock",
            from: { x: 0, y: 0, layer: "top" },
            to: { x: 10, y: 0, layer: "top" },
          },
        ],
      },
    ],
  }
  expect(fixedRouteLength(input, "clock")).toBe(10)
  const targets = minimumLengthTargets(input, [data])
  expect(targets.get("data")).toBeCloseTo(8, 6)
  expect(targets.get("clock")).toBe(10)
})
