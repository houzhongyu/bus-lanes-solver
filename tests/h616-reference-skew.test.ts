import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import {
  validateOriginalEndpointConnectivity,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import {
  BusLanesPipelineSolver,
  type Bus,
  type ConnectionName,
  type SimpleRouteJson,
  type Trace,
} from "../lib"
import { nativeValidationSrj } from "./fixtures/expect-completed-routing"
import { createCopperPathMeasurer } from "./fixtures/h616-reference-skew/path-length"

type Rule = {
  name: string
  names: ConnectionName[]
  tolerance: number
  skewReference?: "mean" | "references"
  references: ConnectionName[]
}
type Fixture = {
  input: SimpleRouteJson
  phases: { names: ConnectionName[]; buses: Bus[] }[]
  constraints: Rule[]
  preservation: { name: string; names: ConnectionName[]; range: number }[]
}

function measureSignalLength({
  input,
  clockBuses,
  generatedTraces,
  connectionName,
}: {
  input: SimpleRouteJson
  clockBuses: Bus[]
  generatedTraces: Trace[]
  connectionName: ConnectionName
}): number {
  const connection = input.connections.find((c) => c.name === connectionName)!
  const path = clockBuses
    .flatMap((b) => b.lengthMatchingPaths ?? [])
    .find((p) => p.connectionName === connectionName)
  const ends = path
    ? path.pcbPortIds.map(
        (id) => connection.pointsToConnect.find((p) => p.pcb_port_id === id)!,
      )
    : connection.pointsToConnect.slice(0, 2)
  const ports = new Map(
    ends.map((p, i) => [
      String(i),
      { ...p, layers: p.layers ?? [p.layer], source_port_id: String(i) },
    ]),
  )
  const traces = generatedTraces.filter(
    (t) => t.connection_name === connectionName,
  )
  const vias = traces.flatMap((t) =>
    t.route.flatMap((p) =>
      p.route_type === "via"
        ? [
            {
              ...p,
              pcb_trace_id: t.pcb_trace_id,
              layers: p.layers ?? ["top", "inner1", "inner2", "bottom"],
            },
          ]
        : [],
    ),
  )
  const length = createCopperPathMeasurer({ routes: traces, ports, vias })(
    "0",
    "1",
  )
  expect(length).not.toBeNull()
  return length!
}

test("fresh H616 DDR routing connects every branch and meets all nine original skew rules", (): void => {
  const fixture: Fixture = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/h616-reference-skew/unrouted.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  )
  const original = structuredClone(fixture.input),
    generated: Trace[] = [],
    started = performance.now()
  expect(original.traces).toHaveLength(0)
  expect(original.connections).toHaveLength(53)
  for (const [index, phase] of fixture.phases.entries()) {
    const input: SimpleRouteJson = {
      ...original,
      connections: original.connections.filter((c) =>
        phase.names.includes(c.name),
      ),
      traces: structuredClone(generated),
      buses: structuredClone(phase.buses),
    }
    const before = structuredClone(input),
      solver = new BusLanesPipelineSolver(input, {
        maxRoutingTimeMs: Math.max(1, 120000 - (performance.now() - started)),
      })
    solver.solve()
    expect(solver.solved, solver.error ?? `phase ${index}`).toBe(true)
    expect(input).toEqual(before)
    generated.push(...solver.traces)
  }
  const native = nativeValidationSrj(original)
  const routed = nativeValidationSrj({ ...original, traces: generated })
  const connectivity = validateOriginalEndpointConnectivity({
    inputSrj: native,
    routedSrj: routed,
  })
  expect(connectivity.valid).toBe(true)
  expect(connectivity.connectedConnectionCount).toBe(53)
  expect(
    validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: routed,
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    }).valid,
  ).toBe(true)
  const lengths = new Map(
    original.connections.map((connection) => [
      connection.name,
      measureSignalLength({
        input: original,
        clockBuses: fixture.phases[1].buses,
        generatedTraces: generated,
        connectionName: connection.name,
      }),
    ]),
  )
  expect(fixture.constraints).toHaveLength(9)
  for (const rule of fixture.constraints) {
    const memberLengthsMm = rule.names.map((name) => lengths.get(name)!),
      meanLengthMm =
        memberLengthsMm.reduce((sum, lengthMm) => sum + lengthMm, 0) /
        memberLengthsMm.length
    const skew =
      rule.skewReference === "mean"
        ? Math.max(
            ...memberLengthsMm.map((lengthMm) =>
              Math.abs(lengthMm - meanLengthMm),
            ),
          )
        : rule.skewReference === "references"
          ? Math.max(
              ...rule.names
                .filter((n) => !rule.references.includes(n))
                .flatMap((n) =>
                  rule.references.map((ref) =>
                    Math.abs(lengths.get(n)! - lengths.get(ref)!),
                  ),
                ),
            )
          : Math.max(...memberLengthsMm) - Math.min(...memberLengthsMm)
    expect(skew, rule.name).toBeLessThanOrEqual(rule.tolerance + 1e-6)
  }
  for (const rule of fixture.preservation) {
    const memberLengthsMm = rule.names.map((name) => lengths.get(name)!)
    expect(
      Math.max(...memberLengthsMm) - Math.min(...memberLengthsMm),
      rule.name,
    ).toBeLessThanOrEqual(rule.range + 1e-6)
  }
  expect(fixture.input).toEqual(original)
}, 130000)
