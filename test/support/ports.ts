import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

/**
 * Test servers listen only on ports from EINVOICE_AE_TEST_PORTS (default 58801-58809), so
 * the suite can share a machine with other services.
 *
 * Ports are handed out in rotation: consecutive servers get different ports. HTTP clients
 * pool connections per origin, and a connection to a server that a previous test has just
 * closed can still be in the pool; a new server on the same port would then see a spurious
 * network error on its first request.
 */
const [first, last] = (process.env['EINVOICE_AE_TEST_PORTS'] ?? '58801-58809').split('-').map(Number) as [number, number];
let next = first;

export async function listenInRange(listen: (port: number) => Promise<unknown>): Promise<number> {
  const count = last - first + 1;
  for (let i = 0; i < count; i += 1) {
    const port = first + ((next - first + i) % count);
    try {
      await listen(port);
      next = port + 1 > last ? first : port + 1;
      return port;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(`No free port in ${first}-${last}; set EINVOICE_AE_TEST_PORTS to another range`);
}

export interface RunningServer {
  readonly url: string;
  close(): Promise<void>;
}

/**
 * Starts a plain HTTP server for a request handler on a port from the test range. Every
 * response closes its connection, so a pooled socket from an earlier test can never be
 * reused against a later server on the same port.
 */
export async function startHttpServer(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<RunningServer> {
  const server = createServer((request, response) => {
    response.setHeader('connection', 'close');
    handler(request, response);
  });
  const port = await listenInRange(
    (p) =>
      new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(p, '127.0.0.1', () => {
          server.off('error', reject);
          resolve();
        });
      }),
  );
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
