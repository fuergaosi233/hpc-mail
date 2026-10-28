import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
// These assertions concern SQLite's planner/row-read counters, not PostgreSQL.
// PostgreSQL plans and audit rollback are checked in server/postgres.test.ts.
const sqliteOnly = [
  'sync：未读数与首页同计划', 'domain/星标/搜索/回收站/未认领/审计他人邮箱保持原计划',
  '联系人按地址取最近 400 封', '未读数（/api 封顶与 /v1 精确）沿',
  '线程：候选按 message_id', 'mailboxes 列表的 messageCount 子查询按地址走索引',
  '收件/未读/已发送只读几十行', 'resolveNotifyOwnerIds 未认领分支只扫',
  '收窄后的 UPDATE 仍按地址集合走', '列表带 domain 时认领/共享范围不改走',
  '999 个多域地址的实时配额只聚合一次', '补录查询使用待补录部分索引',
  '批量封号事实按去重域名物化，EXPLAIN',
  '全部/翻页/按地址走 idx_messages_address_deleted_id',
  '归纳语句走 created_at 与 purge_token 索引', '引用判定的每个子查询都走',
];
const pattern = '^(?!.*(?:' + sqliteOnly.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')).*$';
export default defineConfig({
  resolve: { alias: {
    'cloudflare:test': fileURLToPath(new URL('./server/test-env.ts', import.meta.url)),
    'cloudflare:email': fileURLToPath(new URL('./server/email-message.ts', import.meta.url)),
  } },
  test: { setupFiles: ['./server/test-setup.ts'], fileParallelism: false, testTimeout: 30000, hookTimeout: 30000, testNamePattern: pattern, exclude: ['**/node_modules/**', '**/dist/**'] },
});
