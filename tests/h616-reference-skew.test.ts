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
  type SimpleRouteJson,
  type Trace,
} from "../lib"
import { createCopperPathMeasurer } from "./fixtures/h616-reference-skew/path-length"

type Rule = {
  name: string
  names: string[]
  tolerance: number
  skewReference?: "mean" | "references"
  references: string[]
}
type Fixture = {
  input: SimpleRouteJson
  phases: { names: string[]; buses: Bus[] }[]
  constraints: Rule[]
  preservation: { name: string; names: string[]; range: number }[]
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
  const measure = (name: string): number => {
    const connection = original.connections.find((c) => c.name === name)!
    const path = fixture.phases[1].buses
      .flatMap((b) => b.lengthMatchingPaths ?? [])
      .find((p) => p.connectionName === name)
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
    const traces = generated.filter((t) => t.connection_name === name)
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
    const length = createCopperPathMeasurer(
      traces as never,
      ports as never,
      vias as never,
    )("0", "1")
    expect(length).not.toBeNull()
    return length!
  }
  for (const [index, phase] of fixture.phases.entries()) {
    const input: SimpleRouteJson = {
      ...original,
      connections: original.connections.filter((c) =>
        phase.names.includes(c.name),
      ),
      traces: structuredClone(generated),
      buses: structuredClone(phase.buses),
    }
    if (index === 2) {
      const clocks = fixture.phases[1].names.map(measure),
        limit = fixture.constraints.find(
          (r) => r.name === "U2 address/command to CK (original matching)",
        )!.tolerance
      input.buses!.push({
        busId: "clock_reference",
        connectionNames: phase.names,
        minLength: Math.max(0, Math.max(...clocks) - limit),
        maxLength: Math.min(...clocks) + limit,
        allowedLayers: ["top", "inner1", "inner2", "bottom"],
      })
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
  const native = {
      ...original,
      obstacles: original.obstacles.map((o) => ({
        ...o,
        type: "rect" as const,
      })),
    },
    routed = { ...native, traces: generated }
  const connectivity = validateOriginalEndpointConnectivity({
    inputSrj: native,
    routedSrj: routed,
  } as never)
  expect(connectivity.valid).toBe(true)
  expect(connectivity.connectedConnectionCount).toBe(53)
  expect(
    validateRoutedCopperDrc({
      inputSrj: native,
      routedSrj: routed,
      clearance: 0.1,
      allowBlindAndBuriedVias: false,
    } as never).valid,
  ).toBe(true)
  const lengths = new Map(
    original.connections.map((c) => [c.name, measure(c.name)]),
  )
  expect(fixture.constraints).toHaveLength(9)
  for (const rule of fixture.constraints) {
    const values = rule.names.map((n) => lengths.get(n)!),
      mean = values.reduce((sum, v) => sum + v, 0) / values.length
    const skew =
      rule.skewReference === "mean"
        ? Math.max(...values.map((v) => Math.abs(v - mean)))
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
          : Math.max(...values) - Math.min(...values)
    expect(skew, rule.name).toBeLessThanOrEqual(rule.tolerance + 1e-6)
  }
  for (const rule of fixture.preservation) {
    const values = rule.names.map((n) => lengths.get(n)!)
    expect(
      Math.max(...values) - Math.min(...values),
      rule.name,
    ).toBeLessThanOrEqual(rule.range + 1e-6)
  }
  expect(fixture.input).toEqual(original)
}, 130000)
