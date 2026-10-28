import { PostgresDatabase } from './postgres.js';
import { FileBucket, PostgresKV } from './storage.js';
import type { Env } from '../src/types.js';
import { randomUUID } from 'node:crypto';

const schema = 'test_' + randomUUID().replaceAll('-', '');
const db = new PostgresDatabase(process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@127.0.0.1:15432/hpc_test', schema);
await db.pool.query(`CREATE SCHEMA "${schema}"`);
const prepare = db.prepare.bind(db);
db.prepare = (sql: string) => {
  // The upstream fault-injection test installs a SQLite-only test trigger.
  // Use an equivalent native PostgreSQL trigger, preserving the rollback test.
  if (sql.includes('CREATE TRIGGER fail_transfer_audit')) sql = 'CREATE TRIGGER fail_transfer_audit BEFORE INSERT ON admin_audit_logs FOR EACH ROW EXECUTE FUNCTION hpc_test_fail_audit()';
  if (sql === 'DROP TRIGGER fail_transfer_audit') sql += ' ON admin_audit_logs';
  return prepare(sql);
};
export const bucket = new FileBucket('/tmp/hpc-pg-tests/' + schema);
export const env = {
  db, r2: bucket, kv: new PostgresKV(db), jwt_secret: 'test-jwt-secret-for-vitest-only-0000000000',
  email: { async send() { throw new Error('destination address not verified'); } },
} as unknown as Env & { TEST_MIGRATIONS: unknown };
export function createExecutionContext() { const promises: Promise<unknown>[] = []; return { promises, waitUntil(p: Promise<unknown>) { promises.push(p); }, passThroughOnException() {} }; }
export async function waitOnExecutionContext(ctx: ReturnType<typeof createExecutionContext>) { while (ctx.promises.length) await Promise.allSettled(ctx.promises.splice(0)); }
export async function applyD1Migrations() { await db.migrate(new URL('../migrations', import.meta.url).pathname); }
export { db, schema };
