// npm run smoke:pack
//
// Packs the library as npm would publish it, installs the tarball into an empty project
// and checks that (1) the three entry points import under plain Node.js ESM and build a
// document, (2) require() loads them where Node.js supports require(esm), (3) no shipped
// file points to a source map that is not in the package, and (4) TypeScript resolves
// the type declarations through the exports map.
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'einvoice-ae-smoke-'));
const windows = process.platform === 'win32';
// npm is a .cmd script on Windows, which Node.js only starts through a shell; the command
// is then passed as one quoted string.
const npm = (args, cwd) =>
  windows
    ? execSync(['npm', ...args.map((a) => JSON.stringify(a))].join(' '), { cwd, stdio: 'inherit' })
    : execFileSync('npm', args, { cwd, stdio: 'inherit' });
const node = (args, cwd) => execFileSync(process.execPath, args, { cwd, stdio: 'inherit' });

try {
  npm(['pack', '--pack-destination', work], root);
  const tarball = readdirSync(work).find((f) => f.endsWith('.tgz'));
  if (!tarball) throw new Error('npm pack produced no tarball');

  const app = join(work, 'app');
  mkdirSync(app);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module' }));
  npm(['install', '--no-audit', '--no-fund', '--ignore-scripts', join(work, tarball)], app);

  writeFileSync(
    join(app, 'smoke.mjs'),
    `
import assert from 'node:assert/strict';
import { buildInvoice, issueDocument, PINT_AE } from 'einvoice-ae';
import { HttpAspClient, toSubmission } from 'einvoice-ae/provider';
import { MockAspServer } from 'einvoice-ae/testing';

const party = (name, tin, trn, subdivision) => ({
  name, endpoint: { id: tin }, trn,
  legalRegistration: { id: 'DEMO-TL', type: 'TL', authority: 'Demo Authority' },
  address: { street: '1 Demo Street', city: 'Dubai', subdivision, country: 'AE' },
});
const built = buildInvoice({
  id: 'SMOKE-1', uuid: '00000000-0000-4000-8000-000000000000', issueDate: '2026-09-01', dueDate: '2026-09-30',
  note: 'DEMO - not a tax invoice', currency: 'AED',
  seller: party('Demo Seller', '1000000001', '100000000100003', 'DXB'),
  buyer: party('Demo Buyer', '1000000002', '100000000200003', 'AUH'),
  paymentMeans: [{ code: '30', account: { id: 'AE000000000000000000001' } }],
  lines: [{ quantity: '2', unitCode: 'H87', unitPrice: 1000, item: { name: 'Item', description: 'Item' }, tax: { category: 'S' } }],
});
assert.ok(built.xml.includes(PINT_AE.customizationId));
assert.equal(built.totals.payableAmount, 2100);
const issued = issueDocument(built);
assert.equal(typeof HttpAspClient, 'function');
assert.equal(typeof MockAspServer, 'function');
assert.equal(toSubmission(issued).sha256, issued.sha256);
console.log('Runtime smoke test passed on Node.js ' + process.version);
`,
  );
  node(['smoke.mjs'], app);

  if (process.features.require_module) {
    writeFileSync(
      join(app, 'smoke.cjs'),
      `
const assert = require('node:assert/strict');
assert.equal(typeof require('einvoice-ae').buildInvoice, 'function');
assert.equal(typeof require('einvoice-ae/provider').HttpAspClient, 'function');
assert.equal(typeof require('einvoice-ae/testing').MockAspServer, 'function');
console.log('require() loads the ESM package on Node.js ' + process.version);
`,
    );
    node(['--no-warnings', 'smoke.cjs'], app);
  } else {
    console.log(`Node.js ${process.version} has no require(esm); the CommonJS check is skipped.`);
  }

  const installed = join(app, 'node_modules', 'einvoice-ae', 'dist');
  const shipped = readdirSync(installed, { recursive: true }).map(String).filter((f) => /\.(js|d\.ts)$/.test(f));
  const withMaps = shipped.filter((f) => readFileSync(join(installed, f), 'utf8').includes('sourceMappingURL'));
  if (withMaps.length > 0) throw new Error(`Shipped files refer to source maps that are not in the package: ${withMaps.join(', ')}`);
  console.log(`${shipped.length} shipped files, none refers to a missing source map.`);

  writeFileSync(
    join(app, 'types.ts'),
    `
import { buildInvoice, type InvoiceInput, type BuiltDocument } from 'einvoice-ae';
import { HttpAspClient, type AccreditedServiceProvider } from 'einvoice-ae/provider';
import { MockAspServer, type Fault } from 'einvoice-ae/testing';
const provider: AccreditedServiceProvider = new HttpAspClient({ baseUrl: 'http://127.0.0.1:1', apiKey: 'k' });
const fault: Fault = { kind: 'reset' };
declare const input: InvoiceInput;
const built: BuiltDocument = buildInvoice(input);
export { provider, fault, built, MockAspServer };
`,
  );
  writeFileSync(
    join(app, 'tsconfig.json'),
    // A typical Node.js TypeScript project: strict, NodeNext resolution and @types/node
    // (the declarations use Node's fetch, AbortSignal and http types).
    JSON.stringify({
      compilerOptions: {
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        target: 'ES2022',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        typeRoots: [join(root, 'node_modules', '@types')],
        types: ['node'],
      },
      files: ['types.ts'],
    }),
  );
  node([join(root, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', app], app);
  console.log('Type declarations resolve through the exports map.');
} finally {
  rmSync(work, { recursive: true, force: true });
}
