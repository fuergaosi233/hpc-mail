import { build } from 'esbuild';
import { mkdir, cp } from 'node:fs/promises';
await mkdir('server-dist', { recursive: true });
await build({ entryPoints: ['server/main.ts'], outfile: 'server-dist/server.mjs', bundle: true, platform: 'node', target: 'node22', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" }, external: ['pg-native'], alias: { 'cloudflare:email': './server/email-message.ts' }, logLevel: 'info' });
await cp('dist', 'server-dist/assets', { recursive: true });
await cp('migrations', 'server-dist/migrations', { recursive: true });
