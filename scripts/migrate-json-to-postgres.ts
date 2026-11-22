import 'dotenv/config';
import { db, isSqlEnvConfigured, pool } from '../src/db/index.ts';
import { migrateLegacyJsonToPostgres } from '../server/legacyMigration.ts';
import { createObjectStorageProvider } from '../server/objectStorage.ts';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const dryRun = !apply;
  const ownerArg = args.find((a) => a.startsWith('--owner-email='));
  const ownerEmail = ownerArg ? ownerArg.split('=')[1] : undefined;

  if (!isSqlEnvConfigured()) {
    console.error(
      'SQL_HOST, SQL_USER, SQL_PASSWORD, and SQL_DB_NAME must be configured before running migration.'
    );
    process.exit(1);
  }

  const storageProvider = createObjectStorageProvider();
  const report = await migrateLegacyJsonToPostgres({
    db,
    storageProvider,
    dryRun,
    ownerEmail,
  });

  console.log(JSON.stringify(report, null, 2));
  if (!report.integrityVerified) {
    console.error('Migration integrity verification failed.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error('Migration error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
