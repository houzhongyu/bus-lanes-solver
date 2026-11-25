import { expect, test } from "bun:test"
import { BusLanesSolver, type SimpleRouteJson, type Trace } from "../lib"
import { busLengthReports } from "../lib/route-lengths"

function fixture(lengths: number[]): {
  input: SimpleRouteJson
  traces: Trace[]
} {
  const input: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    minTraceToPadEdgeClearance: 0.1,
    bounds: { minX: -2, maxX: 16, minY: -3, maxY: 20 },
    obstacles: [],
    connections: lengths.map((length, i) => ({
      name: `D${i}`,
      pointsToConnect: [
        { x: 0, y: i * 5, layer: "top" },
        { x: length, y: i * 5, layer: "top" },
      ],
    })),
    buses: [
      {
        busId: "timing",
        connectionNames: lengths.map((_, i) => `D${i}`),
        maxLengthSkew: 2,
        skewReference: "mean",
      },
    ],
  }
  const traces: Trace[] = input.connections.map((c) => ({
    type: "pcb_trace",
    pcb_trace_id: c.name,
    connection_name: c.name,
    route: c.pointsToConnect.map((p) => ({
      ...p,
      route_type: "wire",
      width: 0.1,
    })),
  }))
  return { input, traces }
}

test("mean validation uses actual class mean rather than its range", (): void => {
  for (const lengths of [
    [1, 1, 4],
    [1, 1, 5],
  ]) {
    const { input, traces } = fixture(lengths)
    const solver = BusLanesSolver.forValidation(input, traces)
    solver.solve()
    expect(solver.solved).toBe(lengths[2] === 4)
  }
})

test("mean matching tunes the shortest feasible non-shortening targets", (): void => {
  const { input, traces } = fixture([1, 1, 4])
  input.buses![0].maxLengthSkew = 1
  const before = structuredClone(input),
    solver = BusLanesSolver.forRefinement(input, traces, { smoothTuning: true })
  solver.solve()
  expect(solver.solved).toBe(true)
  expect(input).toEqual(before)
  const report = busLengthReports(input, solver.traces)[0]
  expect(report.matched).toBe(true)
  expect(
    report.lengths.reduce((sum, l) => sum + l.totalLengthMm!, 0),
  ).toBeCloseTo(9, 6)
})

test("reference limits compare every subject to each reference and exclude reference-reference distances", (): void => {
  const { input, traces } = fixture([4, 12, 8, 8])
  input.buses![0] = {
    busId: "relative",
    connectionNames: ["D0", "D1", "D2", "D3"],
    maxLengthSkew: 4,
    skewReference: "references",
    referenceConnectionNames: ["D0", "D1"],
  }
  const solver = BusLanesSolver.forValidation(input, traces)
  solver.solve()
  expect(solver.solved).toBe(true)
  input.buses![0].maxLengthSkew = 3.9
  const failing = BusLanesSolver.forValidation(input, traces)
  failing.solve()
  expect(failing.solved).toBe(false)
})

test("overlapping timing groups retain width requirements and reject ambiguous reference members", (): void => {
  const { input, traces } = fixture([1, 1, 4])
  input.buses!.push({ ...input.buses![0], busId: "overlap", traceWidth: 0.1 })
  let solver = BusLanesSolver.forValidation(input, traces)
  solver.solve()
  expect(solver.solved).toBe(true)
  input.buses![0].traceWidth = 0.2
  expect(() => BusLanesSolver.forValidation(input, traces)).toThrow(
    "conflicting trace widths",
  )
  input.buses = [
    {
      busId: "bad",
      connectionNames: ["D0", "D1", "D2"],
      maxLengthSkew: 2,
      skewReference: "references",
      referenceConnectionNames: ["missing"],
    },
  ]
  expect(() => BusLanesSolver.forValidation(input, traces)).toThrow(
    "Invalid bus reference members",
  )
})
