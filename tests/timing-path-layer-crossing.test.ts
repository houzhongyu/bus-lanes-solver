import { expect, test } from "bun:test"
import { measureSignalPath } from "../lib/measure-signal-path"
import type { SimpleRouteJson, Trace } from "../lib"

test("a same-net crossing on different layers does not create a timing path", () => {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    connections: [],
    obstacles: [],
    bounds: { minX: -2, maxX: 2, minY: -2, maxY: 2 },
  }
  const traces: Trace[] = [
    {
      type: "pcb_trace",
      pcb_trace_id: "top",
      connection_name: "clock",
      route: [
        { route_type: "wire", x: -1, y: 0, layer: "top", width: 0.1 },
        { route_type: "wire", x: 1, y: 0, layer: "top", width: 0.1 },
      ],
    },
    {
      type: "pcb_trace",
      pcb_trace_id: "bottom",
      connection_name: "clock",
      route: [
        { route_type: "wire", x: 0, y: -1, layer: "bottom", width: 0.1 },
        { route_type: "wire", x: 0, y: 1, layer: "bottom", width: 0.1 },
      ],
    },
  ]
  expect(
    measureSignalPath({
      input,
      traces,
      connectionName: "clock",
      from: { x: -1, y: 0, layer: "top" },
      to: { x: 0, y: 1, layer: "bottom" },
    }),
  ).toBeNull()
})
