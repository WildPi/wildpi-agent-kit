import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { OPENAPI_URL, MANIFEST_URL, sameJson, manifestFromOpenApi } from './spec-utils.mjs';

export class NetworkError extends Error {}

export function isNetworkError(error) {
  if (['TimeoutError', 'AbortError'].includes(error?.name)) return true;
  if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(error?.code)) return true;
  if (error?.cause && isNetworkError(error.cause)) return true;
  return Array.isArray(error?.errors) && error.errors.length > 0 && error.errors.every(isNetworkError);
}

export async function fetchJson(url, fetcher, optional = false) {
  let response;
  try { response = await fetcher(url, { signal: AbortSignal.timeout(20_000), redirect: 'error', headers: { Accept: 'application/json' } }); }
  catch (error) {
    if (isNetworkError(error)) throw new NetworkError('Could not fetch live specs (network or timeout).');
    throw new Error('Live spec request failed before receiving a response.');
  }
  if (optional && [404, 410].includes(response.status)) return null;
  if (!response.ok) throw new Error(`Live spec request failed with HTTP ${response.status}.`);
  try { return await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('Live spec returned invalid JSON.');
    if (isNetworkError(error)) throw new NetworkError('Live spec download was interrupted.');
    throw new Error('Could not read the live spec response.');
  }
}

export async function checkSpec({ root = new URL('../', import.meta.url), fetcher = globalThis.fetch, update = false } = {}) {
  // Complete all reads before changing either snapshot.
  const openapi = await fetchJson(OPENAPI_URL, fetcher);
  if (!openapi.paths || !openapi.openapi) throw new Error('Live OpenAPI document has an invalid shape.');
  if (!update && !sameJson(JSON.parse(await readFile(new URL('spec/openapi.json', root), 'utf8')), openapi)) {
    throw new Error('spec/openapi.json differs from live API. Run npm run spec:update and review the changes.');
  }
  const published = await fetchJson(MANIFEST_URL, fetcher, true);
  const generated = manifestFromOpenApi(openapi);
  const tools = published ?? generated;
  if (!Array.isArray(tools.tools) || !tools.tools.length) throw new Error('Live MCP manifest has an invalid shape.');
  if (published && !sameJson(published, generated)) throw new Error('Live manifest and live OpenAPI disagree.');
  const snapshots = [['openapi.json', openapi], ['mcp-tools.json', tools]];
  for (const [name, live] of snapshots) {
    const file = new URL(`spec/${name}`, root);
    if (update) await writeFile(file, `${JSON.stringify(live, null, 2)}\n`);
    else if (!sameJson(JSON.parse(await readFile(file, 'utf8')), live)) throw new Error(`spec/${name} differs from live API. Run npm run spec:update and review the changes.`);
  }
  return published ? 'OpenAPI and published MCP manifest match.' : 'OpenAPI matches; MCP manifest derived from OpenAPI (no published manifest).';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(await checkSpec({ update: process.argv.includes('--update') })); }
  catch (error) {
    if (error instanceof NetworkError && process.argv.includes('--allow-network-error') && !process.argv.includes('--update')) {
      console.warn('::warning::Live spec check skipped due to network failure. Snapshots were not changed.');
    } else { console.error(error.message); process.exitCode = 1; }
  }
}
