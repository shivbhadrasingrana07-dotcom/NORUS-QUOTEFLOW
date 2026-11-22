import 'dotenv/config';
import { db, isSqlEnvConfigured, pool } from '../src/db/index.ts';
import {
  bootstrapFirstOwnerDirect,
  inspectOrganizationOwnership,
  issueFirstOwnerClaimToken,
} from '../server/ownerBootstrap.ts';

function getArgValue(args: string[], prefix: string): string | undefined {
  const hit = args.find((a) => a.startsWith(prefix));
  return hit ? hit.slice(prefix.length).trim() : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const orgId = getArgValue(args, '--org-id=') || 'org-kalyani-hydraulics';
  const email = getArgValue(args, '--email=');
  const ttlHoursRaw = getArgValue(args, '--ttl-hours=');
  const ttlHours = ttlHoursRaw ? Number(ttlHoursRaw) : 72;

  if (!isSqlEnvConfigured()) {
    console.error('SQL_HOST, SQL_USER, SQL_PASSWORD, and SQL_DB_NAME must be configured.');
    process.exit(1);
  }

  if (args.includes('--claim-direct')) {
    if (!email) {
      console.error('--email=<registered-user-email> is required with --claim-direct.');
      process.exit(1);
    }
    const result = await bootstrapFirstOwnerDirect({
      db,
      organizationId: orgId,
      userEmail: email,
    });
    console.log(JSON.stringify({ mode: 'claim-direct', ...result }, null, 2));
    return;
  }

  if (args.includes('--issue-token')) {
    if (!email) {
      console.error('--email=<founder-email> is required with --issue-token.');
      process.exit(1);
    }
    const issued = await issueFirstOwnerClaimToken({
      db,
      organizationId: orgId,
      allowedEmail: email,
      ttlHours: Number.isFinite(ttlHours) ? ttlHours : 72,
    });
    const baseUrl =
      process.env.APP_URL && process.env.APP_URL !== 'MY_APP_URL'
        ? process.env.APP_URL.replace(/\/+$/, '')
        : 'http://localhost:3000';
    console.log(
      JSON.stringify(
        {
          mode: 'issue-token',
          invitationId: issued.invitationId,
          organizationId: issued.organizationId,
          organizationName: issued.organizationName,
          allowedEmail: issued.allowedEmail,
          expiresAt: issued.expiresAt,
          claimUrl: `${baseUrl}/?invite=${encodeURIComponent(issued.rawClaimToken)}`,
        },
        null,
        2
      )
    );
    return;
  }

  const status = await inspectOrganizationOwnership(db, orgId);
  console.log(JSON.stringify({ mode: 'inspect', ...status }, null, 2));
}

main()
  .catch((err) => {
    console.error('Bootstrap error:', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => undefined);
  });
