/**
 * Text mutations for building deliberately broken documents from valid ones. Each helper
 * insists on an exact number of matches, so a change in the generated XML cannot silently
 * turn a broken case into a no-op.
 */

function count(xml: string, search: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = xml.indexOf(search, from);
    if (at === -1) return n;
    n += 1;
    from = at + search.length;
  }
}

/** Replaces the only occurrence of `search`. Throws unless there is exactly one. */
export function replaceOnce(xml: string, search: string, replacement: string): string {
  const n = count(xml, search);
  if (n !== 1) throw new Error(`Expected exactly one occurrence of ${JSON.stringify(search)}, found ${n}`);
  return xml.replace(search, () => replacement);
}

/** Replaces every occurrence of `search`. Throws when there is none. */
export function replaceEvery(xml: string, search: string, replacement: string): string {
  if (count(xml, search) === 0) throw new Error(`No occurrence of ${JSON.stringify(search)}`);
  return xml.split(search).join(replacement);
}

/** Removes the only line that contains `search` (the element and its indentation). */
export function removeLine(xml: string, search: string): string {
  const lines = xml.split('\n');
  const matches = lines.filter((line) => line.includes(search));
  if (matches.length !== 1) throw new Error(`Expected exactly one line containing ${JSON.stringify(search)}, found ${matches.length}`);
  return lines.filter((line) => !line.includes(search)).join('\n');
}

/**
 * Removes the only element block that starts with the line containing `openTag`, up to
 * the matching closing tag at the same indentation.
 */
export function removeBlock(xml: string, openTag: string): string {
  const lines = xml.split('\n');
  const starts = lines.flatMap((line, i) => (line.trimStart().startsWith(openTag) ? [i] : []));
  if (starts.length !== 1) throw new Error(`Expected exactly one block starting with ${openTag}, found ${starts.length}`);
  const start = starts[0] as number;
  const startLine = lines[start] as string;
  const indent = startLine.slice(0, startLine.length - startLine.trimStart().length);
  const name = openTag.replace(/^</, '').replace(/[\s>].*$/, '');
  if (startLine.includes(`</${name}>`)) return [...lines.slice(0, start), ...lines.slice(start + 1)].join('\n');
  const end = lines.findIndex((line, i) => i > start && line === `${indent}</${name}>`);
  if (end === -1) throw new Error(`No closing tag for ${openTag}`);
  return [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n');
}

/** Inserts `snippet` (already indented) on a new line after the only line containing `anchor`. */
export function insertAfterLine(xml: string, anchor: string, snippet: string): string {
  const lines = xml.split('\n');
  const matches = lines.flatMap((line, i) => (line.includes(anchor) ? [i] : []));
  if (matches.length !== 1) throw new Error(`Expected exactly one line containing ${JSON.stringify(anchor)}, found ${matches.length}`);
  const at = matches[0] as number;
  return [...lines.slice(0, at + 1), snippet, ...lines.slice(at + 1)].join('\n');
}
