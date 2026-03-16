/**
 * Next.js instrumentation hook — runs once when the server starts.
 *
 * Used to start the gossip sync background worker.
 * See: https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  // Only run on the server (not during build or in edge runtime)
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    try {
      const { startSyncWorker } = await import('./lib/gossip-sync');
      startSyncWorker();
    } catch {
      // Sync worker will start lazily via gossip API routes
    }
  }
}
