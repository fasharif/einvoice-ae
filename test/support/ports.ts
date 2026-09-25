import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';

/**
 * Test servers listen only on ports from EINVOICE_AE_TEST_PORTS (default 58801-58809), so
 * the suite can share a machine with other services. Each call takes the first free port.
 */
const [first, last] = (process.env['EINVOICE_AE_TEST_PORTS'] ?? '58801-58809').split('-').map(Number) as [number, number];

export async function listenInRange(listen: (port: number) => Promise<unknown>): Promise<number> {
  for (let port = first; port <= last; port += 1) {
    try {
      await listen(port);
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
