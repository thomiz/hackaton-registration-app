import { buildApp } from './app.js';
import type { Config } from './config.js';
import { JsonFileStore } from './file-store.js';
import { preloadStaff } from './preload.js';

export async function startApplication(config: Config, store?: JsonFileStore) {
  store ??= await JsonFileStore.open(config.dataDir);
  const { app, service } = await buildApp(store, config);
  let stopping = false;
  app.server.on('request', (_request, response) => {
    response.once('finish', () => {
      // Node does not automatically close keep-alive sockets that become idle during shutdown.
      if (stopping) app.server.closeIdleConnections();
    });
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    stopping = true;
    try { await app.close(); }
    finally { await store!.close(); }
  })();
  try {
    await service.initialize();
    const preloaded = await preloadStaff(service);
    if (preloaded) app.log.info({ count: preloaded }, 'Preloaded agenda staff roster; no attendance recorded.');
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await close();
    throw error;
  }
  return { app, service, store, close };
}

export async function runUntilStopped(running: Awaited<ReturnType<typeof startApplication>>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const shutdown = () => {
      process.removeListener('SIGINT', shutdown);
      process.removeListener('SIGTERM', shutdown);
      running.close().then(resolve, reject);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}
