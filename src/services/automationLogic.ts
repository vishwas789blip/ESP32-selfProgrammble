/**
 * Pure automation helpers (no database, no MQTT) so they can be unit-tested.
 */

/** Marker: "the previous value of this sensor is not known". */
export const NO_PREVIOUS = Symbol('NO_PREVIOUS')

export function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function normalizeComparable(value: unknown, other: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === 'true') return true
    if (trimmed === 'false') return false

    const otherIsNumber =
      typeof other === 'number' ||
      (typeof other === 'string' && other.trim() !== '' && Number.isFinite(Number(other)))

    if (otherIsNumber && trimmed !== '' && Number.isFinite(Number(trimmed))) {
      return Number(trimmed)
    }
  }

  return value
}

export function evaluateCondition(
  operator: string,
  currentValue: unknown,
  expectedValue: unknown,
  // Rest parameter instead of a default value: a default would also kick in when the
  // caller explicitly passes `undefined` (the previous value of a sensor's very first
  // reading), which must count as "known: there was no value before".
  ...previous: [previousValue?: unknown]
): boolean {
  const hasPrevious = previous.length > 0 && previous[0] !== NO_PREVIOUS
  const previousValue = previous[0]
  const normalizedCurrent = normalizeComparable(currentValue, expectedValue)
  const normalizedExpected = normalizeComparable(expectedValue, currentValue)

  switch (operator) {
    case 'equals':
    case '==':
      return normalizedCurrent === normalizedExpected

    case 'not_equals':
    case '!=':
      return normalizedCurrent !== normalizedExpected

    case '>':
    case 'greater_than':
      return Number(normalizedCurrent) > Number(normalizedExpected)

    case '>=':
    case 'greater_than_or_equal':
      return Number(normalizedCurrent) >= Number(normalizedExpected)

    case '<':
    case 'less_than':
      return Number(normalizedCurrent) < Number(normalizedExpected)

    case '<=':
    case 'less_than_or_equal':
      return Number(normalizedCurrent) <= Number(normalizedExpected)

    case 'contains':
      return String(normalizedCurrent).toLowerCase().includes(String(normalizedExpected).toLowerCase())

    case 'starts_with':
      return String(normalizedCurrent).toLowerCase().startsWith(String(normalizedExpected).toLowerCase())

    case 'ends_with':
      return String(normalizedCurrent).toLowerCase().endsWith(String(normalizedExpected).toLowerCase())

    // True only when this reading differs from the previous one. It used to be a
    // constant `true`, which with the rising-edge latch fired exactly once, ever.
    // The previous value is only known for the sensor that just reported, so in a
    // multi-condition rule `changed` on any other sensor is false.
    case 'changed':
      return hasPrevious && !valuesEqual(currentValue, previousValue)

    case 'exists':
      return normalizedCurrent !== undefined && normalizedCurrent !== null

    case 'in':
      return (
        Array.isArray(normalizedExpected) &&
        normalizedExpected.some(v => normalizeComparable(normalizedCurrent, v) === normalizeComparable(v, normalizedCurrent))
      )

    case 'between': {
      if (!Array.isArray(normalizedExpected) || normalizedExpected.length < 2) return false
      const n = Number(normalizedCurrent)
      return Number.isFinite(n) && n >= Number(normalizedExpected[0]) && n <= Number(normalizedExpected[1])
    }

    default:
      console.warn(`[AUTOMATION] Unsupported operator: ${operator}`)
      return false
  }
}

export type Simulation =
  | { ok: true; value: unknown; previous?: unknown }
  | { ok: false; reason: string }

/**
 * A sensor value that makes `operator expected` true. Used by the "Test automation"
 * button. The old test simply replayed `expected` itself, which can never satisfy
 * strict operators such as `>` or `<` (30 > 30 is false).
 */
export function valueThatSatisfies(operator: string, expected: unknown, currentStored?: unknown): Simulation {
  const num = Number(expected)

  switch (operator) {
    case 'equals':
    case '==':
    case 'contains':
    case 'starts_with':
    case 'ends_with':
      return { ok: true, value: expected }

    case '>=':
    case 'greater_than_or_equal':
    case '<=':
    case 'less_than_or_equal':
      return Number.isFinite(num) ? { ok: true, value: num } : { ok: false, reason: `"${String(expected)}" is not a number` }

    case 'not_equals':
    case '!=': {
      if (typeof expected === 'boolean') return { ok: true, value: !expected }
      if (Number.isFinite(num) && expected !== '' && expected !== null) return { ok: true, value: num + 1 }
      return { ok: true, value: `${String(expected)}_test` }
    }

    case '>':
    case 'greater_than':
      return Number.isFinite(num) ? { ok: true, value: num + 1 } : { ok: false, reason: `"${String(expected)}" is not a number` }

    case '<':
    case 'less_than':
      return Number.isFinite(num) ? { ok: true, value: num - 1 } : { ok: false, reason: `"${String(expected)}" is not a number` }

    case 'changed':
      return { ok: true, value: `__test_${Date.now()}`, previous: currentStored }

    case 'exists':
      return { ok: true, value: expected ?? 1 }

    case 'in':
      return Array.isArray(expected) && expected.length > 0
        ? { ok: true, value: expected[0] }
        : { ok: false, reason: '`in` needs a non-empty list' }

    case 'between':
      return Array.isArray(expected) && expected.length >= 2 && Number.isFinite(Number(expected[0]))
        ? { ok: true, value: Number(expected[0]) }
        : { ok: false, reason: '`between` needs [min, max]' }

    default:
      return { ok: false, reason: `Unsupported operator: ${operator}` }
  }
}
