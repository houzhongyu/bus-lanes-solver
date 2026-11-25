import { solve, type Constraint } from "yalps"
import type {
  ConnectionName,
  LengthSkewConstraint,
  SimpleRouteJson,
} from "./types"

type LengthBoundId = number

/** Minimum added planar copper in mm. Mean bounds use
 * |N * memberLength - sum(memberLengths)| <= N * tolerance. */
export function solveLengthTargets({
  input,
  targets,
  skewConstraints,
}: {
  input: SimpleRouteJson
  targets: ReadonlyMap<ConnectionName, number>
  skewConstraints: LengthSkewConstraint[]
}): Map<ConnectionName, number> {
  const objective: LengthBoundId = 0
  let nextBoundId: LengthBoundId = 1
  const bounds = new Map<LengthBoundId, Constraint>()
  const variables = new Map<ConnectionName, Map<LengthBoundId, number>>()
  for (const [connectionName, minimumLength] of targets) {
    const boundId = nextBoundId++
    const maximumLength = Math.min(
      Infinity,
      ...(input.buses ?? [])
        .filter((bus) => bus.connectionNames.includes(connectionName))
        .map((bus) => bus.maxLength ?? Infinity),
    )
    const bound: { min: number; max?: number } = { min: minimumLength }
    if (
      !input.connections.some(
        (connection) => connection.name === connectionName,
      )
    )
      bound.max = minimumLength
    else if (Number.isFinite(maximumLength)) bound.max = maximumLength
    bounds.set(boundId, bound)
    variables.set(
      connectionName,
      new Map([
        [objective, 1],
        [boundId, 1],
      ]),
    )
  }
  for (const constraint of skewConstraints) {
    const count = constraint.names.length
    for (const connectionName of constraint.names) {
      if (constraint.skewReference === "mean") {
        const boundId = nextBoundId++
        const tolerance = count * constraint.tolerance
        bounds.set(boundId, { min: -tolerance, max: tolerance })
        for (const memberName of constraint.names) {
          let coefficient = -1
          if (memberName === connectionName) coefficient += count
          variables.get(memberName)!.set(boundId, coefficient)
        }
        continue
      }
      for (const otherName of constraint.names) {
        if (otherName === connectionName) continue
        if (
          constraint.skewReference === "references" &&
          constraint.referenceNames?.includes(connectionName) ===
            constraint.referenceNames?.includes(otherName)
        )
          continue
        const boundId = nextBoundId++
        bounds.set(boundId, { max: constraint.tolerance })
        variables.get(connectionName)!.set(boundId, 1)
        variables.get(otherName)!.set(boundId, -1)
      }
    }
  }
  const solution = solve({
    direction: "minimize",
    objective,
    constraints: bounds,
    variables,
  })
  if (solution.status !== "optimal") {
    throw Error("Length matching constraints have no feasible targets")
  }
  // Several equally short solutions can put all added length on one lane.
  // Keep the minimum total copper, then minimize the largest correction so
  // a single crowded lane does not have to fit the entire tuning bank.
  const totalBound = nextBoundId++
  bounds.set(totalBound, { max: solution.result + 1e-7 })
  const maximumAddedLength = Symbol("maximum added length")
  const balancedVariables = new Map<
    ConnectionName | typeof maximumAddedLength,
    Map<LengthBoundId, number>
  >(variables)
  const maximum = new Map<LengthBoundId, number>([[objective, 1]])
  for (const [name, coefficients] of variables) {
    coefficients.set(objective, 0)
    coefficients.set(totalBound, 1)
    if (!input.connections.some((connection) => connection.name === name))
      continue
    const bound = nextBoundId++
    bounds.set(bound, { max: targets.get(name)! })
    coefficients.set(bound, 1)
    maximum.set(bound, -1)
  }
  balancedVariables.set(maximumAddedLength, maximum)
  const balanced = solve({
    direction: "minimize",
    objective,
    constraints: bounds,
    variables: balancedVariables,
  })
  if (balanced.status !== "optimal")
    throw Error("Length matching constraints have no balanced targets")
  const result = new Map(targets)
  for (const [name, value] of balanced.variables) {
    if (typeof name === "string") result.set(name, value)
  }
  return result
}
