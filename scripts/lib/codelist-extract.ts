/** Pulls the code values out of an assert test expression. */
export function extractCodes(test: string): string[] {
  // Form 1: contains(' A B C ', concat(' ', normalize-space(.), ' '))
  const spaced = /contains\(\s*'((?:\s+[^'\s]+)+\s+)'/.exec(test);
  if (spaced?.[1]) return spaced[1].trim().split(/\s+/);
  // Form 2: cbc:CountrySubentity = ("AUH", "DXB", ...)
  const sequence = /=\s*\(((?:\s*"[^"]+"\s*,?)+)\)/.exec(test);
  if (sequence?.[1]) return [...sequence[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '');
  throw new Error(`No code list found in test: ${test.slice(0, 120)}`);
}
