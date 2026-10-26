import { createServer, type AddressInfo, type Server } from "node:net";

export interface QaPortBlock {
  port: number;
  /** Release only the instance about to start; other adjacent instances stay reserved. */
  release(offset?: number, count?: number): Promise<void>;
}

const safeBlock = (port: number, count: number) => port > 0 && port + count - 1 <= 65535
  && !(port <= 4318 && port + count - 1 >= 4317);

/** Hold a complete loopback block through fixture setup, until just before spawning its servers.
 * A listen(0) probe alone does not protect the adjacent phone listener or a second instance.
 * Call release in teardown too, so failed setup never keeps a reservation alive.
 */
export async function reserveQaPorts(count = 2, override?: string): Promise<QaPortBlock> {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error("QA port count must be between 1 and 32");
  const requested = override === undefined ? 0 : Number(override);
  if (override !== undefined && (!/^\d+$/.test(override) || !Number.isInteger(requested) || !safeBlock(requested, count)))
    throw new Error("QA port override must fit a complete block outside live ports 4317/4318");
  for (let attempt = 0; attempt < 100; attempt++) {
    const servers: Server[] = [];
    const close = (server: Server) => new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close(error => error ? reject(error) : resolve());
    });
    try {
      let port = requested;
      for (let offset = 0; offset < count; offset++) {
        const server = createServer(socket => socket.destroy());
        servers.push(server);
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(offset ? port + offset : port, "127.0.0.1", () => {
            server.removeListener("error", reject);
            resolve();
          });
        });
        server.unref();
        if (!offset) {
          port = (server.address() as AddressInfo).port;
          if (!safeBlock(port, count)) break;
        }
      }
      if (!safeBlock(port, count)) { await Promise.all(servers.map(close)); continue; }
      const released = new Map<number, Promise<void>>();
      return {
        port,
        async release(offset = 0, length = count - offset) {
          if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > count)
            throw new Error("QA port release must stay within its reserved block");
          await Promise.all(servers.slice(offset, offset + length).map((server, index) => {
            const key = offset + index;
            if (!released.has(key)) released.set(key, close(server));
            return released.get(key)!;
          }));
        },
      };
    } catch (error) {
      await Promise.all(servers.map(close));
      if (override !== undefined || (error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  throw new Error(`Could not reserve ${count} consecutive QA ports`);
}
