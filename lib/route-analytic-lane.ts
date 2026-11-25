import { length } from "./geometry"
import { RouteConflictIndex } from "./route-conflict-index"
import { VectorScene, type Copper } from "./vector-scene"
import { VectorVisibilitySearch } from "./vector-visibility"
import type { Connection, SimpleRouteJson, Trace, Wire } from "./types"

/** Recover a lane when no permitted raster layer can route it. Board-world
 * points are right-handed XY mm, +X right and +Y up. Fixed copper stays hard;
 * provisional lane conflicts contribute the ordinary negotiation cost. */
export function* routeAnalyticLane({
  input,
  connection,
  width,
  layers,
  hardCopper,
  routedTraces,
  maxLengthMm,
}: {
  input: SimpleRouteJson
  connection: Connection
  width: number
  layers: readonly string[]
  hardCopper: Copper[]
  routedTraces: Trace[]
  maxLengthMm: number
}): Generator<void, { trace: Trace; score: number } | undefined> {
  const conflicts = new RouteConflictIndex()
  const clearance =
    input.minTraceToPadEdgeClearance ?? input.defaultObstacleMargin ?? 0.075
  let best: { trace: Trace; score: number } | undefined
  for (const layer of layers) {
    const candidate = {
      ...connection,
      pointsToConnect: connection.pointsToConnect.map((point) => ({
        ...point,
        layer,
      })),
    }
    const scene = new VectorScene(input, candidate, width, hardCopper)
    const search = new VectorVisibilitySearch(
      scene,
      candidate.pointsToConnect[0],
      candidate.pointsToConnect[1],
    )
    while (!search.solved && !search.failed) {
      search.step()
      yield
    }
    if (!search.solved || length(search.result) > maxLengthMm + 1e-7) continue
    let crossings = 0
    for (const trace of routedTraces) {
      const first = trace.route[0] as Wire
      if (first.layer !== layer) continue
      if (
        conflicts.firstConflict(
          search.result,
          trace.route,
          (width + first.width) / 2 + clearance - 1e-8,
        )
      )
        crossings++
    }
    const score =
      length(search.result) + crossings * length(candidate.pointsToConnect)
    if (best && best.score <= score) continue
    best = {
      score,
      trace: {
        type: "pcb_trace",
        pcb_trace_id: `bus_lane_${connection.name}`,
        connection_name: connection.name,
        source_trace_id: connection.source_trace_id ?? connection.name,
        route: search.result.map((point) => ({
          ...point,
          route_type: "wire",
          layer,
          width,
        })),
      },
    }
  }
  return best
}
