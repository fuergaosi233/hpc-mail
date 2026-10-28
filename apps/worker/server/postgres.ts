import pg from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('PostgreSQL integer exceeds JavaScript safe range');
  return n;
});

// Preserve the application's prepared-statement contract while storing every row
// in PostgreSQL. Parameters are bound, never interpolated into query text.
function calls(source: string, name: string, convert: (args: string[]) => string): string {
  const pattern = new RegExp(`\\b${name}\\s*\\(`, 'gi');
  let match: RegExpExecArray | null;
  let result = '', cursor = 0;
  while ((match = pattern.exec(source))) {
    let depth = 1, quote = '', i = pattern.lastIndex, start = i;
    const args: string[] = [];
    for (; i < source.length && depth; i++) {
      const ch = source[i]!;
      if (quote) {
        if (ch === quote && source[i + 1] === quote) { i++; continue; }
        if (ch === quote) quote = '';
      } else if (ch === "'" || ch === '"') quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (!depth) args.push(source.slice(start, i).trim()); }
      else if (ch === ',' && depth === 1) { args.push(source.slice(start, i).trim()); start = i + 1; }
    }
    if (depth) throw new Error(`Unbalanced ${name} expression`);
    result += source.slice(cursor, match.index) + convert(args);
    cursor = i; pattern.lastIndex = i;
  }
  return result + source.slice(cursor);
}

export function translateSql(input: string, values: unknown[] = [], changed = 0): string {
  if (/CREATE TRIGGER `trg_users_keep_last_admin_(update|delete)`/.test(input)) {
    const deleting = input.includes('BEFORE DELETE');
    const name = deleting ? 'trg_users_keep_last_admin_delete' : 'trg_users_keep_last_admin_update';
    return `CREATE OR REPLACE FUNCTION ${name}_fn() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF OLD.role = 'admin' AND OLD.status = 'active' ${deleting ? '' : "AND (NEW.role <> 'admin' OR NEW.status <> 'active')"}
        AND NOT EXISTS (SELECT 1 FROM users WHERE id <> OLD.id AND role='admin' AND status='active') THEN
        RAISE EXCEPTION 'last_active_admin'; END IF; RETURN ${deleting ? 'OLD' : 'NEW'}; END $$;
      CREATE TRIGGER ${name} BEFORE ${deleting ? 'DELETE' : 'UPDATE OF role,status'} ON users FOR EACH ROW EXECUTE FUNCTION ${name}_fn()`;
  }
  if (input.includes('CREATE TRIGGER `trg_users_consume_invite`')) return `
    CREATE OR REPLACE FUNCTION trg_users_consume_invite_fn() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.invite_id IS NOT NULL THEN
      UPDATE invites SET used_count=used_count+1 WHERE id=NEW.invite_id AND status='active' AND used_count<max_uses
        AND (expires_at IS NULL OR expires_at > floor(extract(epoch from statement_timestamp()))::bigint*1000);
      IF NOT FOUND THEN RAISE EXCEPTION 'invite_invalid'; END IF; END IF; RETURN NEW; END $$;
    CREATE TRIGGER trg_users_consume_invite AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION trg_users_consume_invite_fn()`;
  // Tokenize quoted SQL separately: question marks in mail text and JSON paths
  // must never be interpreted as placeholders.
  let next = 0;
  let sql = input.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`[^`]*`|\?(\d*)/g, (token, index) => {
    if (token[0] === '`') return '"' + token.slice(1, -1) + '"';
    if (token[0] !== '?') return token;
    const n = index ? Number(index) : next + 1;
    next = Math.max(next, n);
    const value = values[n - 1];
    return '$' + n + (typeof value === 'number' ? (Number.isInteger(value) ? '::bigint' : '::double precision') : typeof value === 'string' ? '::text' : '');
  });
  sql = sql.replace(/\bchanges\(\)/gi, String(changed));
  sql = sql.replace(/\bunixepoch\(\)/gi, '(floor(extract(epoch from statement_timestamp()))::bigint)');
  sql = calls(sql, 'instr', ([haystack, needle]) => `strpos(${haystack}, ${needle})`);
  sql = calls(sql, 'substr', ([value, start, length]) => `substr(${value}, (${start})::integer${length ? ', (' + length + ')::integer' : ''})`);
  sql = calls(sql, 'json_extract', ([value, path]) => {
    const numeric = /^'\$\.(revision|autoClaimLimit|perUserLimit|perDomainLimit|ownedDomain|wasTaken|hosted)'$/.test(path!);
    return `${numeric ? 'hpc_json_number' : 'hpc_json_text'}(${value}, ${path})`;
  });
  sql = calls(sql, 'json_each', ([value, path]) => {
    const binding = /^\$(\d+)(?:::text)?$/.exec(value!);
    let numeric = false;
    if (binding) {
      try { const data = JSON.parse(String(values[Number(binding[1]) - 1])); numeric = Array.isArray(data) && (data.length > 0 ? data.every((x) => typeof x === 'number') : /(?:user_id|mailbox_id|\bid)\s+(?:NOT\s+)?IN\s*\(SELECT value FROM json_each\(/i.test(input)); } catch { /* PostgreSQL reports malformed JSON */ }
    }
    return `${numeric ? 'hpc_json_numbers' : 'hpc_json_each'}(${value}${path ? ', ' + path : ''})`;
  });
  // SQLite counts boolean expressions as integers in this one capacity query.
  sql = sql.replace(/EXISTS \(SELECT 1 FROM mailboxes WHERE mailboxes\.address = input\.address\) AS existing/g, '(EXISTS (SELECT 1 FROM mailboxes WHERE mailboxes.address = input.address))::integer AS existing');
  sql = sql.replace(/\bexisting OR occurrence/g, 'existing <> 0 OR occurrence');
  sql = sql.replace(/\bpaid AND suspended\b/g, 'paid <> 0 AND suspended <> 0');
  sql = sql.replace(/\+\s*("[^"]+"\."[^"]+")/g, '$1');
  sql = calls(sql, 'SUM', ([value]) => !/^CASE\b/i.test(value!) && /\bIN\s*\(|\bAND\b|\bOR\b|=/.test(value!) ? `SUM((${value})::integer)` : `SUM(${value})`);
  for (const fn of ['MAX', 'MIN']) sql = calls(sql, fn, (args) => args.length > 1 ? `${fn === 'MAX' ? 'GREATEST' : 'LEAST'}(${args.join(',')})` : `${fn}(${!/^CASE\b/i.test(args[0]!) && /\bLIKE\b|\bEXISTS\b/i.test(args[0]!) ? '(' + args[0] + ')::integer' : args[0]})`);
  sql = sql.replace(/\bWHERE\s+1\b(?!\s*=)/g, 'WHERE TRUE');
  sql = sql.replace(/\bINDEXED BY\s+[a-zA-Z_][a-zA-Z0-9_]*/gi, '');
  sql = sql.replace(/\bon conflict\s*\(([^)]+)\)/gi, (_, columns: string) => 'on conflict (' + columns.replace(/"[^\"]+"\./g, '') + ')');
  if (/INSERT INTO rate_counters/i.test(sql)) sql = sql.replace(/count = count \+/g, 'count = rate_counters.count +').replace(/units = units \+/g, 'units = rate_counters.units +');
  if (/INSERT INTO api_rate_limits/i.test(sql)) sql = sql.replace(/request_count = request_count \+/g, 'request_count = api_rate_limits.request_count +');
  sql = sql.replace(/\bIS\s+NOT\s+(\$\d+)/gi, 'IS DISTINCT FROM $1').replace(/\bIS\s+(\$\d+)/gi, 'IS NOT DISTINCT FROM $1');
  if (/INSERT INTO claude_address_facts/i.test(sql)) sql = sql.replace(/GROUP BY address\b/i, 'GROUP BY address, domain');
  if (/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(sql)) {
    sql = sql.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, 'INSERT INTO').replace(/;\s*$/, '') + ' ON CONFLICT DO NOTHING';
  }
  if (/\bAUTOINCREMENT\b/i.test(sql)) sql = sql.replace(/\binteger\s+PRIMARY KEY\s+AUTOINCREMENT/gi, 'bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY');
  if (/^\s*(CREATE|ALTER)\s/i.test(sql)) sql = sql.replace(/\binteger\b/gi, 'bigint').replace(/DEFAULT false/gi, 'DEFAULT 0').replace(/DEFAULT true/gi, 'DEFAULT 1');
  return sql;
}

const helpers = `
CREATE OR REPLACE FUNCTION hpc_json_text(v text, p text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT v::jsonb #>> string_to_array(substr(p, 3), '.') $$;
CREATE OR REPLACE FUNCTION hpc_json_number(v text, p text) RETURNS bigint LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE WHEN hpc_json_text(v,p) = 'true' THEN 1 WHEN hpc_json_text(v,p) = 'false' THEN 0 ELSE hpc_json_text(v,p)::bigint END $$;
CREATE OR REPLACE FUNCTION hpc_json_each(v text, p text DEFAULT '$') RETURNS TABLE(key text, value text, type text) LANGUAGE sql IMMUTABLE AS $$
 SELECT (a.ordinality - 1)::text,
 CASE WHEN jsonb_typeof(a.value) = 'string' THEN a.value #>> '{}' ELSE a.value::text END,
 CASE WHEN jsonb_typeof(a.value) = 'string' THEN 'text' ELSE jsonb_typeof(a.value) END
 FROM jsonb_array_elements(CASE WHEN p = '$' THEN v::jsonb ELSE v::jsonb #> string_to_array(substr(p,3), '.') END) WITH ORDINALITY a(value, ordinality) $$;
CREATE OR REPLACE FUNCTION hpc_json_numbers(v text, p text DEFAULT '$') RETURNS TABLE(key text, value bigint, type text) LANGUAGE sql IMMUTABLE AS $$
 SELECT key, value::bigint, type FROM hpc_json_each(v,p) $$;
`;

function sqliteError(error: unknown): Error {
  const e = error as { code?: string; table?: string; column?: string; detail?: string; message?: string };
  if (e.code === '23502') return new Error(`NOT NULL constraint failed: ${e.table}.${e.column}`, { cause: error });
  if (e.code === '23505') {
    const column = /Key \(([^)]+)\)/.exec(e.detail ?? '')?.[1];
    return new Error(`UNIQUE constraint failed: ${e.table}.${column}`, { cause: error });
  }
  return error instanceof Error ? error : new Error(String(error));
}

export class PostgresDatabase {
  pool: pg.Pool;
  constructor(connectionString: string, schema = 'public') {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema)) throw new Error('Invalid schema');
    this.pool = new pg.Pool({ connectionString, max: 4, connectionTimeoutMillis: 5000, idleTimeoutMillis: 10000, options: `-c search_path=${schema},public -c statement_timeout=15000` });
  }
  prepare(sql: string) { return new PostgresStatement(this, sql); }
  async batch(statements: PostgresStatement[]) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // D1 serializes writes. Keep CAS + changes() + audit/outbox batches atomic
      // across all server replicas instead of weakening the original guarantees.
      await client.query('SELECT pg_advisory_xact_lock(15400601)');
      const result = []; let changes = 0;
      for (const statement of statements) {
        const item = await statement.execute(client, changes);
        if (['INSERT', 'UPDATE', 'DELETE'].includes(item.command)) changes = item.meta.changes;
        result.push(item);
      }
      await client.query('COMMIT'); return result;
    } catch (error) { await client.query('ROLLBACK'); throw sqliteError(error); }
    finally { client.release(); }
  }
  async exec(sql: string) {
    const started = performance.now();
    await this.pool.query(translateSql(sql));
    return { count: 1, duration: performance.now() - started };
  }
  async migrate(directory: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(15400602)');
      await client.query(helpers);
      await client.query('CREATE TABLE IF NOT EXISTS hpc_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
      for (const name of (await readdir(directory)).filter((x) => x.endsWith('.sql')).sort()) {
        if ((await client.query('SELECT 1 FROM hpc_migrations WHERE name=$1', [name])).rowCount) continue;
        const source = await readFile(directory + '/' + name, 'utf8');
        for (const statement of source.split('--> statement-breakpoint').filter((s) => s.trim())) await client.query(translateSql(statement));
        await client.query('INSERT INTO hpc_migrations (name) VALUES ($1)', [name]);
      }
      await client.query(`CREATE OR REPLACE FUNCTION hpc_assign_id() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        IF NEW.id IS NULL THEN NEW.id := nextval(pg_get_serial_sequence(format('%I.%I', TG_TABLE_SCHEMA, TG_TABLE_NAME), 'id')); END IF; RETURN NEW; END $$`);
      const identities = await client.query("SELECT table_name FROM information_schema.columns WHERE table_schema=current_schema() AND column_name='id' AND is_identity='YES'");
      for (const { table_name: table } of identities.rows) await client.query(`CREATE OR REPLACE TRIGGER hpc_assign_id BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION hpc_assign_id()`);
      await client.query('CREATE TABLE IF NOT EXISTS hpc_kv (key text PRIMARY KEY, value text NOT NULL, expires_at bigint)');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
}

export class PostgresStatement {
  values: unknown[] = [];
  constructor(public database: PostgresDatabase, public sql: string) {}
  bind(...values: unknown[]) { const s = new PostgresStatement(this.database, this.sql); s.values = values; return s; }
  async execute(client: pg.PoolClient, changed = 0) {
    const started = performance.now();
    const sql = translateSql(this.sql, this.values, changed);
    try {
      const r = await client.query({ text: sql, values: this.values, rowMode: 'array' });
      // Postgres folds unquoted aliases, whereas SQLite retains camelCase.
      const aliases = [...this.sql.matchAll(/\bAS\s+([a-zA-Z_][a-zA-Z0-9_]*)/gi)].map((m) => m[1]!);
      const rawRows = r.rows.map((row: unknown[]) => row.map((v) => typeof v === 'boolean' ? Number(v) : v));
      const rows = rawRows.map((values: unknown[]) => {
        const row: Record<string, unknown> = Object.fromEntries(r.fields.map((field, i) => [field.name, values[i]]));
        for (const alias of aliases) if (alias !== alias.toLowerCase() && alias.toLowerCase() in row) { row[alias] = row[alias.toLowerCase()]; delete row[alias.toLowerCase()]; }
        for (const k of Object.keys(row)) if (typeof row[k] === 'boolean') row[k] = Number(row[k]);
        return row;
      });
      return { success: true, command: r.command, results: rows, rawRows, meta: { changes: /^(SELECT|EXPLAIN)$/i.test(r.command) ? 0 : r.rowCount ?? 0, last_row_id: rows[0]?.id ?? 0, duration: performance.now() - started, rows_read: r.rowCount ?? 0, rows_written: r.command === 'SELECT' ? 0 : r.rowCount ?? 0 }, columns: r.fields.map((f) => aliases.find((a) => a.toLowerCase() === f.name) ?? f.name) };
    } catch (error) { throw sqliteError(error); }
  }
  async all<T = Record<string, unknown>>() { return (await this.database.batch([this]))[0]! as unknown as { results: T[]; meta: { changes: number }; success: boolean }; }
  async run() { return this.all(); }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> { const row = (await this.all<Record<string, unknown>>()).results[0]; return (column ? row?.[column] : row) as T ?? null; }
  async raw(options?: { columnNames?: boolean }) { const result = (await this.database.batch([this]))[0]!; return options?.columnNames ? [result.columns, ...result.rawRows] : result.rawRows; }
}
