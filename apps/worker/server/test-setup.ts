import { afterAll } from 'vitest';
import { rm } from 'node:fs/promises';
import { db, schema, bucket } from './test-env.js';
await db.migrate(new URL('../migrations', import.meta.url).pathname);
await db.pool.query(`CREATE FUNCTION hpc_test_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.action='mailbox.transfer' THEN RAISE EXCEPTION 'test audit unavailable'; END IF; RETURN NEW; END $$`);
afterAll(async () => { await db.pool.query(`DROP SCHEMA "${schema}" CASCADE`); await db.pool.end(); await rm(bucket.root, { recursive: true, force: true }); });
