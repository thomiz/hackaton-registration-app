import { loadConfig } from './config.js';
import { runUntilStopped, startApplication } from './startup.js';

try {
  const config = loadConfig();
  const running = await startApplication(config);
  console.log(`Check-in app ready at ${config.publicUrl} (data: ${config.dataDir}). Press Ctrl+C to stop.`);
  await runUntilStopped(running);
} catch (error) {
  console.error('The check-in server failed:', error instanceof Error ? error.message : 'Unknown error');
  process.exitCode = 1;
}
