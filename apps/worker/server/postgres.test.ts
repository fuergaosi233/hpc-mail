import { describe, expect, it } from 'vitest';
import { db } from './test-env.js';

describe('PostgreSQL deployment guarantees', () => {
  it('binds values and preserves literal question marks', async () => {
    const row = await db.prepare("SELECT '?2' AS literal, ? AS value, ? AS number").bind("quote ' ? DROP TABLE users", 42).first();
    expect(row).toEqual({ literal: '?2', value: "quote ' ? DROP TABLE users", number: 42 });
  });
  it('serializes concurrent mutations and preserves changes across reads', async () => {
    await db.pool.query('CREATE TABLE pg_atomic (id bigint PRIMARY KEY, n bigint NOT NULL)');
    await db.pool.query('INSERT INTO pg_atomic VALUES (1,0)');
    await Promise.all(Array.from({ length: 25 }, () => db.batch([
      db.prepare('UPDATE pg_atomic SET n=n+1 WHERE id=1'),
      db.prepare('SELECT n FROM pg_atomic WHERE id=1'),
      db.prepare('UPDATE pg_atomic SET n=n+1 WHERE id=1 AND changes()=1'),
    ])));
    expect((await db.pool.query('SELECT n FROM pg_atomic')).rows[0].n).toBe(50);
  });
  it('rolls back an ownership update when its mandatory audit insert fails', async () => {
    await db.pool.query("CREATE TABLE pg_owner (id bigint PRIMARY KEY, owner bigint NOT NULL); INSERT INTO pg_owner VALUES (1,10); CREATE TABLE pg_audit (id bigint NOT NULL)");
    await expect(db.batch([
      db.prepare('UPDATE pg_owner SET owner=20 WHERE id=1'),
      db.prepare('INSERT INTO pg_audit (id) VALUES (NULL)'),
    ])).rejects.toThrow('NOT NULL constraint');
    expect((await db.pool.query('SELECT owner FROM pg_owner WHERE id=1')).rows[0].owner).toBe(10);
  });
  it('PostgreSQL can use the mailbox, outbox and attachment reference indexes', async () => {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL enable_seqscan=off');
      for (const [query, expected] of [
        ["SELECT id FROM messages WHERE address='probe@multi-agent.wiki' AND deleted_at IS NULL ORDER BY id DESC LIMIT 50", 'idx_messages_address'],
        ['SELECT id FROM messages WHERE notify_owner_ids IS NOT NULL AND notifications_queued_at IS NULL AND deleted_at IS NULL ORDER BY created_at,id LIMIT 10', 'idx_messages_notification_outbox'],
        ["SELECT id FROM attachments WHERE r2_key='probe'", 'idx_attachments_r2_key'],
      ]) {
        const result = await client.query('EXPLAIN (FORMAT JSON) ' + query);
        expect(JSON.stringify(result.rows)).toContain(expected);
      }
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});
