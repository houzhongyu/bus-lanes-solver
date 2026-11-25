import { length } from "./geometry"
import { measureSignalPath } from "./measure-signal-path"
import { solveLengthTargets } from "./solve-length-targets"
import type { LengthSkewConstraint, SimpleRouteJson, Trace } from "./types"

/** Planar copper length already routed for a connection. Via depth and package
 * delay require stackup/package data and are not inferred from XY coordinates. */
export function fixedRouteLength(input: SimpleRouteJson, name: string) {
  const connection = input.connections.find(
    (candidate) => candidate.name === name,
  )
  const path = input.buses
    ?.flatMap((bus) => bus.lengthMatchingPaths ?? [])
    .find((candidate) => candidate.connectionName === name)
  if (path) {
    if (!connection) {
      const measured = measureSignalPath({
        input,
        traces: input.traces ?? [],
        ...path,
      })
      if (measured === null)
        throw Error("A fixed timing reference has no connected endpoint path")
      return measured
    }
    if (connection.pointsToConnect.length > 2) return 0
    let shortest = Infinity
    for (const ends of [
      connection.pointsToConnect,
      connection.pointsToConnect.toReversed(),
    ]) {
      const prefix = measureSignalPath({
        input,
        traces: input.traces ?? [],
        connectionName: name,
        from: path.from,
        to: ends[0],
      })
      const suffix = measureSignalPath({
        input,
        traces: input.traces ?? [],
        connectionName: name,
        from: path.to,
        to: ends[1],
      })
      if (prefix !== null && suffix !== null)
        shortest = Math.min(shortest, prefix + suffix)
    }
    if (!Number.isFinite(shortest))
      throw Error(
        "Fixed handoffs do not connect to the selected timing endpoints",
      )
    return shortest
  }
  if (!connection)
    throw Error("A fixed timing reference needs explicit endpoint paths")
  return (input.traces ?? [])
    .filter(
      (t) =>
        t.connection_name === name ||
        t.source_trace_id === (connection?.source_trace_id ?? name),
    )
    .reduce((sum, t) => sum + length(t.route), 0)
}
export function busLengthReports(input: SimpleRouteJson, traces: Trace[]) {
  return (input.buses ?? []).map((bus) => {
    const names = [
      ...new Set([
        ...bus.connectionNames,
        ...(bus.referenceConnectionNames ?? []),
      ]),
    ]
    const lengths = names.map((name) => {
      const route = traces.find((trace) => trace.connection_name === name)
      const path = bus.lengthMatchingPaths?.find(
        (path) => path.connectionName === name,
      )
      let totalLengthMm: number | null = null
      const fixedLengthMm = fixedRouteLength(input, name)
      if (path)
        totalLengthMm = measureSignalPath({
          input,
          traces: [...(input.traces ?? []), ...traces],
          ...path,
        })
      else if (route) totalLengthMm = length(route.route) + fixedLengthMm
      return {
        name,
        carrierLengthMm: route ? length(route.route) : null,
        fixedLengthMm,
        totalLengthMm,
      }
    })
    const members = lengths.filter((member) =>
      bus.connectionNames.includes(member.name),
    )
    const complete = lengths.every((member) => member.totalLengthMm !== null)
    const values = members.map((member) => member.totalLengthMm ?? 0)
    let measuredSkewMm: number | null = null
    if (complete && values.length) {
      const comparisonLengths = lengths.map((member) => member.totalLengthMm!)
      measuredSkewMm =
        Math.max(...comparisonLengths) - Math.min(...comparisonLengths)
      if (bus.skewReference === "mean") {
        const mean =
          comparisonLengths.reduce((sum, lengthMm) => sum + lengthMm, 0) /
          comparisonLengths.length
        measuredSkewMm = Math.max(
          ...comparisonLengths.map((lengthMm) => Math.abs(lengthMm - mean)),
        )
      }
      if (bus.skewReference === "references") {
        const references = lengths.filter((member) =>
          bus.referenceConnectionNames?.includes(member.name),
        )
        const subjects = members.filter(
          (member) => !bus.referenceConnectionNames?.includes(member.name),
        )
        measuredSkewMm = Math.max(
          0,
          ...subjects.flatMap((subject) =>
            references.map((reference) =>
              Math.abs(subject.totalLengthMm! - reference.totalLengthMm!),
            ),
          ),
        )
      }
    }
    return {
      busId: bus.busId,
      minLengthMm: bus.minLength ?? null,
      aboveMinimumLength:
        bus.minLength === undefined
          ? true
          : complete && values.every((value) => value >= bus.minLength! - 1e-7),
      maxLengthMm: bus.maxLength ?? null,
      withinLengthLimit:
        bus.maxLength === undefined
          ? true
          : complete && values.every((value) => value <= bus.maxLength! + 1e-7),
      toleranceMm: bus.maxLengthSkew ?? null,
      skewMm: measuredSkewMm,
      matched:
        bus.maxLengthSkew !== undefined &&
        measuredSkewMm !== null &&
        measuredSkewMm <= bus.maxLengthSkew + 1e-7,
      lengths,
    }
  })
}

/** Existing SRJ skew bounds; omitted bus bounds do not request tuning. */
export function lengthConstraints(
  input: SimpleRouteJson,
): LengthSkewConstraint[] {
  return [
    ...(input.buses ?? [])
      .filter((b) => b.maxLengthSkew !== undefined)
      .map((b) => ({
        names: [
          ...new Set([
            ...b.connectionNames,
            ...(b.referenceConnectionNames ?? []),
          ]),
        ],
        tolerance: b.maxLengthSkew!,
        skewReference: b.skewReference,
        referenceNames: b.referenceConnectionNames,
      })),
    ...(input.differentialPairs ?? []).map((p) => ({
      names: p.connectionNames,
      tolerance: p.lengthTolerance,
    })),
  ]
}

/** Least non-shortening lengths satisfying every overlapping bus/pair bound.
 * Relax difference constraints rather than collapsing connected groups to equality. */
export function minimumLengthTargets(input: SimpleRouteJson, traces: Trace[]) {
  const targets = new Map(
    traces.map((t) => [
      t.connection_name!,
      length(t.route) + fixedRouteLength(input, t.connection_name!),
    ]),
  )
  for (const bus of input.buses ?? [])
    if (bus.minLength !== undefined)
      for (const name of bus.connectionNames)
        if (targets.has(name))
          targets.set(name, Math.max(targets.get(name)!, bus.minLength))
  const constraints = lengthConstraints(input)
  for (const { names } of constraints) {
    for (const name of names) {
      if (!targets.has(name)) targets.set(name, fixedRouteLength(input, name))
    }
  }
  if (
    constraints.some(
      (constraint) =>
        constraint.skewReference === "mean" ||
        constraint.skewReference === "references" ||
        constraint.referenceNames?.some(
          (name) =>
            !input.connections.some((connection) => connection.name === name),
        ),
    )
  ) {
    return solveLengthTargets({
      input,
      targets,
      skewConstraints: constraints,
    })
  }
  for (let pass = 0; pass < targets.size; pass++) {
    let changed = false
    for (const { names, tolerance } of constraints) {
      const floor = Math.max(...names.map((n) => targets.get(n)!)) - tolerance
      for (const name of names)
        if (targets.get(name)! < floor - 1e-9) {
          targets.set(name, floor)
          changed = true
        }
    }
    if (!changed) break
  }
  return targets
}

export function pairLengthReports(input: SimpleRouteJson, traces: Trace[]) {
  return busLengthReports(
    {
      ...input,
      buses: (input.differentialPairs ?? []).map((p, i) => ({
        busId: `pair_${i}`,
        connectionNames: p.connectionNames,
        maxLengthSkew: p.lengthTolerance,
      })),
    },
    traces,
  )
}

/** Remaining carrier budget after immutable copper and generated escapes. */
export function maximumCarrierLength(
  input: SimpleRouteJson,
  name: string,
): number {
  let maximum = Infinity
  for (const bus of input.buses ?? []) {
    if (!bus.connectionNames.includes(name)) continue
    maximum = Math.min(maximum, bus.maxLength ?? Infinity)
    if (bus.maxLengthSkew === undefined) continue
    for (const referenceName of bus.referenceConnectionNames ?? []) {
      if (
        input.connections.some(
          (connection) => connection.name === referenceName,
        )
      )
        continue
      let referenceTolerance = bus.maxLengthSkew
      if (bus.skewReference === "mean") referenceTolerance *= 2
      maximum = Math.min(
        maximum,
        fixedRouteLength(input, referenceName) + referenceTolerance,
      )
    }
  }
  return maximum - fixedRouteLength(input, name)
}

export function assertLengthTargets(
  input: SimpleRouteJson,
  targets: ReadonlyMap<string, number>,
) {
  for (const bus of input.buses ?? [])
    if (
      bus.maxLength !== undefined &&
      bus.connectionNames.some(
        (name) => (targets.get(name) ?? Infinity) > bus.maxLength! + 1e-7,
      )
    )
      throw Error(
        `${bus.busId}: matching would exceed maximum length ${bus.maxLength} mm`,
      )
}
