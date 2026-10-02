/**
 * Runs the validation container (validator/Dockerfile) on files inside the repository and
 * parses its JSON report. Java only ever runs inside that container.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export const DEFAULT_IMAGE = process.env['EINVOICE_AE_VALIDATOR_IMAGE'] ?? 'einvoice-ae-validator:local';

export interface XsdIssue {
  severity: string;
  line: number;
  column: number;
  message: string;
}

export interface SchematronFinding {
  layer: 'pint' | 'pint-ae';
  id: string | null;
  flag: string | null;
  location: string | null;
  text: string;
}

export interface ValidationResult {
  file: string;
  documentType: 'Invoice' | 'CreditNote' | null;
  valid: boolean;
  error: string | null;
  xsd: XsdIssue[];
  schematron: SchematronFinding[];
}

export interface ValidationReport {
  engine: { saxon: string; java: string };
  results: ValidationResult[];
}

export interface RunOptions {
  /** Repository root mounted read-only at /work. Defaults to the current directory. */
  root?: string;
  image?: string;
  memory?: string;
}

/** Distinct IDs of fatal Schematron findings, sorted. */
export function fatalRuleIds(result: ValidationResult): string[] {
  return [...new Set(result.schematron.filter((f) => f.flag === 'fatal' || f.flag === null).map((f) => f.id ?? '(no id)'))].sort();
}

/** Builds the docker arguments; exported for unit tests. */
export function dockerArguments(files: readonly string[], options: Required<RunOptions>, name: string): string[] {
  const root = options.root;
  const inside = files.map((file) => {
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    const rel = relative(root, absolute);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${file} is outside the repository root ${root}`);
    return rel.split(sep).join('/');
  });
  return [
    'run',
    '--rm',
    '--name',
    name,
    '--memory',
    options.memory,
    '--cpus',
    '2',
    '--network',
    'none',
    '--volume',
    `${root}:/work:ro`,
    options.image,
    ...inside,
  ];
}

export function parseReport(stdout: string): ValidationReport {
  const report = JSON.parse(stdout) as ValidationReport;
  if (!report || !Array.isArray(report.results)) throw new Error('Validator output has no results array');
  return report;
}

/** Validates files (paths inside the repository) and returns the parsed report. */
export async function runValidator(files: readonly string[], options: RunOptions = {}): Promise<ValidationReport> {
  if (files.length === 0) throw new Error('No files to validate');
  // realpath resolves Windows filesystem redirection, which Docker Desktop cannot see.
  const settings: Required<RunOptions> = {
    root: realpathSync.native(options.root ?? process.cwd()),
    image: options.image ?? DEFAULT_IMAGE,
    memory: options.memory ?? '1g',
  };
  const name = `einvoice-ae-validator-${randomBytes(4).toString('hex')}`;
  const args = dockerArguments(files, settings, name);

  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => reject(new Error(`Could not start docker: ${error.message}`)));
    child.on('close', (code) => {
      const out = Buffer.concat(stdout).toString('utf8');
      const err = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0 && code !== 1) {
        reject(
          new Error(
            `Validator container exited with code ${code}. ${err}\n` +
              `Build the image first with: npm run validator:build (image ${settings.image})`,
          ),
        );
        return;
      }
      try {
        resolvePromise(parseReport(out));
      } catch (error) {
        reject(new Error(`Could not parse validator output: ${(error as Error).message}\n${err}`));
      }
    });
  });
}
