/**
 * Produces the corpus in memory: every valid scenario, every deliberately broken
 * document and every documented rule gap, with the manifest that states the expected
 * outcome of the official validation for each file.
 */
import { brokenCases } from './broken.js';
import { gapCases } from './gaps.js';
import { scenarios } from './scenarios.js';

export interface CorpusFile {
  /** Path relative to the corpus folder, with forward slashes. */
  readonly path: string;
  readonly content: string;
}

export interface ManifestEntry {
  readonly file: string;
  readonly kind: 'valid' | 'invalid' | 'gap';
  readonly description: string;
  /** Rules the official validator must report: none for valid and gap documents. */
  readonly expectedRules: readonly string[];
  /** For gap documents: the rule whose intent the document breaks without being reported. */
  readonly gapInRule?: string;
}

export interface Corpus {
  readonly files: readonly CorpusFile[];
  readonly manifest: readonly ManifestEntry[];
}

export function generateCorpus(): Corpus {
  const files: CorpusFile[] = [];
  const manifest: ManifestEntry[] = [];
  const valid = new Map<string, string>();

  const baseOf = (name: string, user: string): string => {
    const base = valid.get(name);
    if (base === undefined) throw new Error(`${user} refers to unknown scenario ${name}`);
    return base;
  };

  for (const scenario of scenarios) {
    const xml = scenario.build().xml;
    valid.set(scenario.name, xml);
    const path = `valid/${scenario.name}.xml`;
    files.push({ path, content: xml });
    manifest.push({ file: path, kind: 'valid', description: scenario.description, expectedRules: [] });
  }

  for (const broken of brokenCases) {
    const base = baseOf(broken.base, `Broken case ${broken.rule}`);
    const xml = broken.mutate(base);
    if (xml === base) throw new Error(`Broken case ${broken.rule} did not change the document`);
    const path = `invalid/${broken.rule}.xml`;
    files.push({ path, content: xml });
    manifest.push({ file: path, kind: 'invalid', description: broken.description, expectedRules: [broken.rule] });
  }

  for (const gap of gapCases) {
    const base = baseOf(gap.base, `Gap case ${gap.name}`);
    const xml = gap.mutate(base);
    if (xml === base) throw new Error(`Gap case ${gap.name} did not change the document`);
    const path = `gaps/${gap.name}.xml`;
    files.push({ path, content: xml });
    manifest.push({ file: path, kind: 'gap', description: gap.description, expectedRules: [], gapInRule: gap.rule });
  }

  const manifestJson = `${JSON.stringify({ generatedBy: 'npm run corpus:generate', documents: manifest }, null, 2)}\n`;
  files.push({ path: 'manifest.json', content: manifestJson });
  return { files, manifest };
}
