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
