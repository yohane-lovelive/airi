/** A fixture keeps this many decimals, so a rebuild on another machine gives the same text. */
const DECIMALS = 1e6

function rounded(value: unknown): unknown {
  if (typeof value === 'number')
    // `+ 0` turns -0 into 0.
    return Math.round(value * DECIMALS) / DECIMALS + 0
  if (Array.isArray(value))
    return value.map(rounded)
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rounded(item)]))
  return value
}

/**
 * The text of a fixture of the C# tests of the Unity sidecar. A list of numbers stays on one line, so a diff stays short.
 *
 * Use when:
 * - A test records the output of TypeScript code with `toMatchFileSnapshot`, and C# code must give the same output.
 *
 * To update the fixtures after an intended change, run `vitest run -u` in the package of the test.
 */
export function fixtureText(value: unknown) {
  const text = JSON.stringify(rounded(value), null, 2)
  return `${text.replace(/\[\s+(-?[\d.]+(?:,\s+-?[\d.]+)*)\s+\]/g, (_, numbers: string) => `[${numbers.replace(/\s+/g, ' ')}]`)}\n`
}
