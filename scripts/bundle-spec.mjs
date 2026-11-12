import { copyFile, mkdir } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const target = new URL('packages/cli/spec/', root);
await mkdir(target, { recursive: true });
for (const name of ['openapi.json', 'mcp-tools.json']) await copyFile(new URL(`spec/${name}`, root), new URL(name, target));
await copyFile(new URL('LICENSE', root), new URL('packages/cli/LICENSE', root));
