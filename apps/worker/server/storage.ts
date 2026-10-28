import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PostgresDatabase } from './postgres.js';

async function bytes(value: unknown): Promise<Buffer> {
  if (typeof value === 'string') return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value == null) return Buffer.alloc(0);
  return Buffer.from(await new Response(value as BodyInit).arrayBuffer());
}

/** Disk-backed object storage. Keys are hashed; callers cannot escape the volume. */
export class FileBucket {
  constructor(public root: string) {}
  private path(key: string) { return join(this.root, createHash('sha256').update(key).digest('hex')); }
  async put(key: string, value: unknown, options: { httpMetadata?: Record<string, string>; customMetadata?: Record<string, string> } = {}) {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const body = await bytes(value), file = this.path(key), tmp = file + '.' + randomUUID();
    const meta = { key, version: randomUUID(), size: body.length, etag: createHash('sha256').update(body).digest('hex'), uploaded: new Date().toISOString(), httpMetadata: options.httpMetadata ?? {}, customMetadata: options.customMetadata ?? {} };
    await writeFile(tmp, body, { mode: 0o600 });
    await rename(tmp, file);
    await writeFile(tmp + '.json', JSON.stringify(meta), { mode: 0o600 });
    await rename(tmp + '.json', file + '.json');
    return this.head(key);
  }
  async head(key: string): Promise<any> {
    try {
      const meta = JSON.parse(await readFile(this.path(key) + '.json', 'utf8'));
      return { ...meta, uploaded: new Date(meta.uploaded), httpEtag: '"' + meta.etag + '"', writeHttpMetadata(headers: Headers) { for (const [key, value] of Object.entries(meta.httpMetadata)) headers.set(key.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), String(value)); } };
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async get(key: string, options?: { range?: { offset?: number; length?: number; suffix?: number } }): Promise<any> {
    const meta = await this.head(key); if (!meta) return null;
    let data = await readFile(this.path(key));
    if (options?.range) {
      const r = options.range, start = r.suffix ? Math.max(0, data.length - r.suffix) : r.offset ?? 0;
      data = data.subarray(start, r.length ? start + r.length : undefined);
    }
    return { ...meta, body: new Response(data).body, bodyUsed: false, arrayBuffer: async () => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), text: async () => data.toString(), json: async () => JSON.parse(data.toString()), blob: async () => new Blob([data]) };
  }
  async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) { await rm(this.path(key), { force: true }); await rm(this.path(key) + '.json', { force: true }); } }
  async list(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<any> {
    await mkdir(this.root, { recursive: true });
    const all = [];
    for (const file of await readdir(this.root)) if (/^[a-f0-9]{64}\.json$/.test(file)) {
      const m = JSON.parse(await readFile(join(this.root, file), 'utf8'));
      if ((!options.prefix || m.key.startsWith(options.prefix)) && (!options.cursor || m.key > options.cursor)) all.push(await this.head(m.key));
    }
    all.sort((a, b) => a.key.localeCompare(b.key)); const limit = options.limit ?? 1000;
    return { objects: all.slice(0, limit), truncated: all.length > limit, cursor: all.length > limit ? all[limit - 1].key : undefined, delimitedPrefixes: [] };
  }
  async createMultipartUpload(key: string, options = {}) {
    const id = randomUUID(), dir = join(this.root, 'multipart', id);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(join(dir, 'options.json'), JSON.stringify(options), { mode: 0o600 });
    return this.resumeMultipartUpload(key, id);
  }
  resumeMultipartUpload(key: string, uploadId: string): any {
    if (!/^[a-f0-9-]{36}$/.test(uploadId)) throw new Error('Invalid multipart upload ID');
    const dir = join(this.root, 'multipart', uploadId), bucket = this;
    return { key, uploadId,
      async uploadPart(partNumber: number, value: unknown) {
        if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) throw new Error('Invalid part');
        const data = await bytes(value); await writeFile(join(dir, String(partNumber)), data, { mode: 0o600 });
        return { partNumber, etag: createHash('sha256').update(data).digest('hex') };
      },
      async complete(parts: { partNumber: number; etag: string }[]) {
        const buffers = [];
        for (const p of parts) { const b = await readFile(join(dir, String(p.partNumber))); if (createHash('sha256').update(b).digest('hex') !== p.etag) throw new Error('Multipart ETag mismatch'); buffers.push(b); }
        const result = await bucket.put(key, Buffer.concat(buffers), JSON.parse(await readFile(join(dir, 'options.json'), 'utf8'))); await rm(dir, { recursive: true }); return result;
      },
      async abort() { await rm(dir, { recursive: true, force: true }); },
    };
  }
}

export class PostgresKV {
  constructor(public db: PostgresDatabase) {}
  async get(key: string, type?: string | { type?: string }) {
    const { rows } = await this.db.pool.query('SELECT value FROM hpc_kv WHERE key=$1 AND (expires_at IS NULL OR expires_at > $2)', [key, Date.now()]);
    const value = rows[0]?.value ?? null;
    return (typeof type === 'string' ? type : type?.type) === 'json' && value !== null ? JSON.parse(value) : value;
  }
  async put(key: string, value: string, options?: { expirationTtl?: number; expiration?: number }) { const until = options?.expiration ? options.expiration * 1000 : options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : null; await this.db.pool.query('INSERT INTO hpc_kv (key,value,expires_at) VALUES ($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at', [key, value, until]); }
  async delete(key: string) { await this.db.pool.query('DELETE FROM hpc_kv WHERE key=$1', [key]); }
  async list() { const { rows } = await this.db.pool.query('SELECT key AS name FROM hpc_kv'); return { keys: rows, list_complete: true, cacheStatus: null }; }
}
