import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('spec/mcp-tools.json', root), 'utf8'));
const env = Object.fromEntries(Object.entries(process.env).filter(([, value]) => typeof value === 'string'));
const transport = new StdioClientTransport({ command: process.execPath,
  args: [fileURLToPath(new URL('packages/cli/dist/index.js', root)), 'mcp'],
  env: { ...env, WILDPI_API_KEY: '' }, stderr: 'pipe' });
const client = new Client({ name: 'wildpi-smoke', version: '0.1.0' });
try {
  await client.connect(transport, { timeout: 10_000 }); // initialize + notifications/initialized
  const result = await client.listTools({}, { timeout: 10_000 });
  const expected = manifest.tools.filter((tool) => tool.requiredScope === 'read' && !tool.agentOnly).map(({ name }) => name);
  assert.deepEqual(result.tools.map(({ name }) => name), expected);
  console.log(JSON.stringify({ initialize: 'ok', 'tools/list': result.tools.length, tools: expected }, null, 2));
} finally { await client.close(); }
