import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { gunzipSync } from "node:zlib"
import { BusLanesPipelineSolver, type SimpleRouteJson } from "../lib"

test("native H616 data, masks, and strobes matching phase", (): void => {
  const input = JSON.parse(
    gunzipSync(
      readFileSync(
        new URL("./fixtures/h616-matching-phase.srj.json.gz", import.meta.url),
      ),
    ).toString("utf8"),
  ) as SimpleRouteJson
  const solver = new BusLanesPipelineSolver(input)
  solver.solve()
  expect({
    requested: input.connections.length,
    solved: solver.solved,
    error: solver.error,
  }).toMatchInlineSnapshot(`
    {
      "error": "Negotiated lane search exhausted without a complete route",
      "requested": 22,
      "solved": false,
    }
  `)
}, 120_000)
