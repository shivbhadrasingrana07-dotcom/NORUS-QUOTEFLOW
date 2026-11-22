import 'dotenv/config';
import { db, isSqlEnvConfigured, pool } from '../src/db/index.ts';
import { runScheduledMaintenance } from '../server/maintenance.ts';
import { createObjectStorageProvider } from '../server/objectStorage.ts';

async function main() {
  if (!isSqlEnvConfigured()) {
    console.error('SQL_HOST, SQL_USER, SQL_PASSWORD, and SQL_DB_NAME must be configured.');
    process.exit(1);
  }
  const batchArg = process.argv.slice(2).find((a) => a.startsWith('--batch-size='));
  const batchSize = batchArg ? Number(batchArg.split('=')[1]) : undefined;
  const storageProvider = createObjectStorageProvider();
  const summary = await runScheduledMaintenance({
    db,
    storageProvider,
    batchSize: Number.isFinite(batchSize) ? batchSize : undefined,
  });
  console.log(JSON.stringify(summary, null, 2));
  if (summary.errors.length > 0) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Maintenance failed:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
