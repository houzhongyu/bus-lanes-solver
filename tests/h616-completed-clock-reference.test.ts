import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"
import {
  validateOriginalEndpointConnectivity,
  validateRoutedCopperDrc,
} from "@tscircuit/fanout-solver"
import { busLengthReports } from "../lib/route-lengths"
import { nativeValidationSrj } from "./fixtures/expect-completed-routing"

test("H616 control signals match the completed clock paths", (): void => {
  const {
    input,
    fixedConnections,
  }: {
    input: SimpleRouteJson
    fixedConnections: SimpleRouteJson["connections"]
  } = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL(
          "./fixtures/h616-completed-clock-reference/input.srj.json.gz",
          import.meta.url,
        ),
      ),
    ).toString(),
  )
  const solver = new BusLanesPipelineSolver(input, { maxRoutingTimeMs: 120000 })
  solver.solve()
  if (solver.solved) {
    const native = nativeValidationSrj({
      ...input,
      connections: [...input.connections, ...fixedConnections],
    })
    const routed = nativeValidationSrj({
      ...native,
      traces: solver.getOutput().traces,
    })
    expect(
      validateOriginalEndpointConnectivity({
        inputSrj: native,
        routedSrj: routed,
      }).valid,
    ).toBe(true)
    expect(
      validateRoutedCopperDrc({
        inputSrj: native,
        routedSrj: routed,
        clearance: input.minTraceToPadEdgeClearance!,
      }).valid,
    ).toBe(true)
    expect(
      busLengthReports(input, solver.traces).every((report) => report.matched),
    ).toBe(true)
    const supplied = native.traces ?? []
    expect(routed.traces?.slice(0, supplied.length)).toEqual(supplied)
  }
  expect(solver.solved).toMatchInlineSnapshot(`false`)
}, 130000)
