import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
// JavaScript maintenance scripts are exercised against isolated snapshots.
// @ts-expect-error Scripts intentionally ship as native JavaScript.
import { checkSpec, fetchJson, NetworkError } from './check-spec.mjs';
// @ts-expect-error Scripts intentionally ship as native JavaScript.
import { OPENAPI_URL, MANIFEST_URL, manifestFromOpenApi, sameJson } from './spec-utils.mjs';

const openapi = JSON.parse(await readFile(new URL('../spec/openapi.json', import.meta.url), 'utf8'));
const manifest = JSON.parse(await readFile(new URL('../spec/mcp-tools.json', import.meta.url), 'utf8'));
const folders: string[] = [];
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200 });
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function snapshot() {
  const path = await mkdtemp(join(tmpdir(), 'wildpi-spec-')); folders.push(path);
  await mkdir(join(path, 'spec'));
  await writeFile(join(path, 'spec/openapi.json'), JSON.stringify(openapi));
  await writeFile(join(path, 'spec/mcp-tools.json'), JSON.stringify(manifest));
  return { root: pathToFileURL(`${path}/`), path };
}

describe('live spec maintenance', () => {
  it('reconstructs the existing manifest from OpenAPI when no manifest is published', () => {
    expect(sameJson(manifestFromOpenApi(openapi), manifest)).toBe(true);
  });
  it('compares the public endpoints and ignores object-key order/whitespace', async () => {
    const { root } = await snapshot();
    const fetcher = vi.fn(async (url: string) => json(url === OPENAPI_URL ? openapi : manifest));
    expect(await checkSpec({ root, fetcher })).toContain('match');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual([OPENAPI_URL, MANIFEST_URL]);
  });
  it('compares against OpenAPI when the optional manifest returns 404', async () => {
    const { root } = await snapshot();
    const fetcher = vi.fn(async (url: string) => url === OPENAPI_URL ? json(openapi) : new Response(null, { status: 404 }));
    expect(await checkSpec({ root, fetcher })).toContain('derived from OpenAPI');
  });
  it('fails on snapshot drift and updates both snapshots deliberately', async () => {
    const { root, path } = await snapshot();
    const changed = structuredClone(openapi); changed.info.version = 'test-version';
    const fetcher = vi.fn(async (url: string) => json(url === OPENAPI_URL ? changed : manifest));
    await expect(checkSpec({ root, fetcher })).rejects.toThrow('differs from live API');
    await checkSpec({ root, fetcher, update: true });
    expect(JSON.parse(await readFile(join(path, 'spec/openapi.json'), 'utf8')).info.version).toBe('test-version');
  });
  it('does not soften HTTP errors or malformed JSON into network errors', async () => {
    const http = () => Promise.resolve(new Response('unavailable', { status: 503 }));
    await expect(fetchJson(OPENAPI_URL, http)).rejects.toThrow('HTTP 503');
    const malformed = () => Promise.resolve(new Response('not JSON', { status: 200 }));
    await expect(fetchJson(OPENAPI_URL, malformed)).rejects.not.toBeInstanceOf(NetworkError);
    await expect(fetchJson(OPENAPI_URL, () => Promise.reject(new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } })))).rejects.toBeInstanceOf(NetworkError);
    await expect(fetchJson(OPENAPI_URL, () => Promise.reject(new TypeError('fetch failed', { cause: new Error('unexpected redirect') })))).rejects.not.toBeInstanceOf(NetworkError);
  });
  it('does not partially update snapshots when manifest download fails', async () => {
    const { root, path } = await snapshot();
    const before = await readFile(join(path, 'spec/openapi.json'), 'utf8');
    const fetcher = vi.fn(async (url: string) => url === OPENAPI_URL ? json(openapi) : new Response(null, { status: 500 }));
    await expect(checkSpec({ root, fetcher, update: true })).rejects.toThrow('HTTP 500');
    expect(await readFile(join(path, 'spec/openapi.json'), 'utf8')).toBe(before);
  });
  it('does not hide known OpenAPI drift behind an optional manifest network failure', async () => {
    const { root } = await snapshot();
    const changed = structuredClone(openapi); changed.info.version = 'changed';
    const fetcher = vi.fn(async (url: string) => {
      if (url === OPENAPI_URL) return json(changed);
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    });
    await expect(checkSpec({ root, fetcher })).rejects.toThrow('differs from live API');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
