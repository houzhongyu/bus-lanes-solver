import { test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"
import { expectCompletedRouting } from "./fixtures/expect-completed-routing"

test("routes and matches the native H616 data, masks, and strobes", (): void => {
  const input = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/h616-matching-phase.srj.json.gz", import.meta.url),
      ),
    ).toString("utf8"),
  ) as SimpleRouteJson
  const original = structuredClone(input)
  const solver = new BusLanesPipelineSolver(input)
  solver.solve()
  expectCompletedRouting(solver, original)
}, 120_000)
