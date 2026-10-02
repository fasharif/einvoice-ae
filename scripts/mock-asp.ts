/**
 * npm run mock-asp
 *
 * Starts the mock Accredited Service Provider on 127.0.0.1. Configuration comes from the
 * environment (see .env.example). Stop it with Ctrl+C.
 */
import { MockAspServer } from '../src/testing/index.js';

const port = Number(process.env['MOCK_ASP_PORT'] ?? 58800);
const apiKey = process.env['MOCK_ASP_API_KEY'] ?? 'local-demo-key';
const callbackSecret = process.env['MOCK_ASP_CALLBACK_SECRET'] ?? 'local-demo-secret';

async function main(): Promise<void> {
  const server = new MockAspServer({ apiKey, callbackSecret, processingDelayMs: 500 });
  const url = await server.listen(port);
  console.log(`Mock ASP listening on ${url}`);
  console.log(`  POST ${url}/v1/submissions   (Authorization: Bearer <MOCK_ASP_API_KEY>)`);
  console.log(`  GET  ${url}/v1/submissions/{id}`);
  console.log('This is a test double, not an accredited provider. Press Ctrl+C to stop.');
  const stop = (): void => {
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
