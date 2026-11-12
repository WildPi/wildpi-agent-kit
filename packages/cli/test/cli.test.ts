import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCommand } from '../src/args.js';
import { run } from '../src/cli.js';
import { ApiClient, type Fetch } from '../src/client.js';

const fakeCredential = 'test-environment-credential-not-a-real-key';
const json = (data: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(data), { status, ...(headers ? { headers } : {}) });
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function invoke(argv: string[], config: { key?: string; response?: Response; fetcher?: Fetch; base?: string } = {}) {
  const fetcher = config.fetcher ?? vi.fn<Fetch>().mockResolvedValue(config.response ?? json({ items: [], nextCursor: null }));
  const out: string[] = [], err: string[] = [];
  const code = await run(argv, { env: { WILDPI_API_KEY: config.key ?? '', ...(config.base ? { WILDPI_API_BASE: config.base } : {}) },
    fetch: fetcher, stdout: (text) => { out.push(text); }, stderr: (text) => { err.push(text); } });
  return { code, stdout: out.join(''), stderr: err.join(''), fetcher };
}

describe('argument parsing', () => {
  it('parses filters, global flags anywhere, and optional search text', () => {
    expect(parseCommand(['--json', 'ideas', 'search', 'ai', '--tag', 'buildable', '--sort=new', '--status', 'new', '--limit', '3', '--cursor', 'opaque'])).toMatchObject({
      kind: 'tool', name: 'search_ideas', json: true,
      args: { q: 'ai', tag: 'buildable', sort: 'new', status: 'new', limit: 3, cursor: 'opaque' },
    });
    expect(parseCommand(['tools', 'search', '--pricing', 'free', '--category', 'audio'])).toMatchObject({ name: 'search_tools', args: { pricing: 'free', category: 'audio' } });
    expect(parseCommand(['ideas', 'search'])).toMatchObject({ name: 'search_ideas' });
  });

  it.each([
    [['ideas', 'get', '12'], 'get_idea', { id: 12 }],
    [['ideas', 'comments', '12', '--limit', '2'], 'list_idea_comments', { id: 12, limit: 2 }],
    [['tools', 'get', 'audio-scribe'], 'get_tool', { slug: 'audio-scribe' }],
    [['rankings', '--period', 'all'], 'get_rankings', { period: 'all' }],
    [['shipped', 'list'], 'list_shipped', {}],
    [['shipped', 'get', '5'], 'get_shipped', { id: 5 }],
    [['users', 'get', 'builder'], 'get_user', { handle: 'builder' }],
    [['me'], 'my_profile', {}],
    [['notifications'], 'my_notifications', {}],
    [['saved', '--type', 'tool'], 'my_saved', { type: 'tool' }],
    [['post', 'A concrete idea #buildable'], 'post_idea', { text: 'A concrete idea #buildable' }],
    [['comment', '4', 'A useful comment', '--parent', '2'], 'comment', { id: 4, body: 'A useful comment', parentId: 2 }],
    [['react', '4', 'like'], 'react', { id: 4, kind: 'like', active: true }],
    [['react', '4', 'save', '--off'], 'react', { id: 4, kind: 'save', active: false }],
    [['follow', 'builder', '--off'], 'follow', { handle: 'builder', active: false }],
    [['ask', 'tool', '5', 'Can it run offline?'], 'ask_wildpi', { targetType: 'tool', targetId: 5, question: 'Can it run offline?' }],
    [['ask', 'get', 'a'.repeat(32)], 'get_ask', { id: 'a'.repeat(32) }],
  ])('maps %j to the manifest', (argv, name, args) => {
    expect(parseCommand(argv as string[])).toMatchObject({ kind: 'tool', name, args });
  });

  it.each([
    ['ideas', 'get', '0'], ['ideas', 'get', '9007199254740992'], ['ideas', 'search', '--limit', '1.2'],
    ['ideas', 'search', '--limit', '51'], ['ideas', 'search', '--sort', 'wrong'], ['rankings', '--period', 'year'],
    ['tools', 'search', '--sort', 'hot'], ['post'], ['post', 'text', '--file', 'draft.md'], ['comment', '1'],
    ['react', '1', 'dislike'], ['ask', 'tool', 'tool-slug', 'question'], ['saved', '--unknown'], ['me', '--idempotency-key', 'key'],
    ['me', 'extra'], ['mcp', '--off'], ['post', 'text', '--idempotency-key', 'with space'],
  ].map((argv) => ({ argv })))('rejects invalid input before fetch: $argv', ({ argv }) => { expect(() => parseCommand(argv)).toThrow(); });

  it('accepts dash-prefixed content after --', () => {
    expect(parseCommand(['post', '--', '--an idea'])).toMatchObject({ args: { text: '--an idea' } });
  });
});

describe('HTTP CLI', () => {
  it('does public reads anonymously and emits API JSON', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(json({ items: [{ id: 1, text: 'Idea' }], nextCursor: null }));
    const result = await invoke(['ideas', 'search', 'ai', '--json'], { fetcher });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ items: [{ id: 1, text: 'Idea' }], nextCursor: null });
    const [url, init] = fetcher.mock.calls[0]!;
    const requestUrl = new URL(String(url));
    expect(requestUrl.origin + requestUrl.pathname).toBe('https://api.wildpi.com/v1/ideas');
    expect(Object.fromEntries(requestUrl.searchParams)).toEqual({ sort: 'hot', q: 'ai', limit: '20' });
    expect(new Headers(init?.headers).has('Authorization')).toBe(false);
    expect(init?.redirect).toBe('error');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('takes auth only from env and honors the API-base override', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(json({ user: { kind: 'agent' } }));
    const result = await invoke(['me', '--json'], { key: fakeCredential, fetcher, base: 'https://api.wildpi.com/test/v1/' });
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://api.wildpi.com/test/v1/me');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${fakeCredential}`);
    expect(result.stdout + result.stderr).not.toContain(fakeCredential);
  });

  it.each([
    [['post', 'A concrete idea'], 'POST', '/ideas', { text: 'A concrete idea' }],
    [['comment', '4', 'Useful', '--parent', '2'], 'POST', '/ideas/4/comments', { body: 'Useful', parentId: 2 }],
    [['react', '4', 'like'], 'PUT', '/ideas/4/reactions/like', undefined],
    [['react', '4', 'save', '--off'], 'DELETE', '/ideas/4/reactions/save', undefined],
    [['follow', 'builder'], 'PUT', '/users/builder/follow', undefined],
    [['follow', 'builder', '--off'], 'DELETE', '/users/builder/follow', undefined],
    [['ask', 'idea', '4', 'How?'], 'POST', '/ask', { targetType: 'idea', targetId: 4, question: 'How?' }],
  ])('sends idempotency and the expected request for %j', async (argv, method, path, body) => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(json({ ok: true }));
    const result = await invoke(argv as string[], { key: fakeCredential, fetcher });
    expect(result.code).toBe(0);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.wildpi.com/v1${path}`);
    expect(init?.method).toBe(method);
    expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/);
    expect(init?.body ? JSON.parse(String(init.body)) : undefined).toEqual(body);
  });

  it('uses a supplied idempotency key without including it in JSON body', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(json({ ok: true }));
    await invoke(['post', 'idea', '--idempotency-key', 'intent-123'], { key: fakeCredential, fetcher });
    const init = fetcher.mock.calls[0]![1];
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe('intent-123');
    expect(JSON.parse(String(init?.body))).toEqual({ text: 'idea' });
  });

  it('reads a post file and validates its options', async () => {
    const folder = await mkdtemp(join(tmpdir(), 'wildpi-test-')); folders.push(folder);
    const file = join(folder, 'draft.md'); await writeFile(file, 'Original idea #buildable\n');
    const fetcher = vi.fn<Fetch>().mockResolvedValue(json({ idea: { id: 9 } }));
    const result = await invoke(['post', '--file', file, '--json', '--idempotency-key', 'draft-1'], { key: fakeCredential, fetcher });
    expect(result.code).toBe(0);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({ text: await readFile(file, 'utf8') });
  });

  it('prints Retry-After and exits non-zero after exactly one 429', async () => {
    const fetcher = vi.fn<Fetch>().mockResolvedValue(json({ error: { message: fakeCredential } }, 429, { 'Retry-After': '60' }));
    const result = await invoke(['ideas', 'search', '--json'], { fetcher, key: fakeCredential });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Retry-After: 60');
    expect(result.stdout).toBe('');
    expect(result.stderr).not.toContain(fakeCredential);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('handles 429 without Retry-After', async () => {
    const result = await invoke(['ideas', 'search'], { response: json({}, 429) });
    expect(result.code).toBe(2); expect(result.stderr).toContain('Retry-After: not provided');
  });

  it('never prints a credential from responses, errors, args or fetch exceptions', async () => {
    const success = await invoke(['me', '--json'], { key: fakeCredential, response: json({ note: fakeCredential, nested: [encodeURIComponent(fakeCredential)] }) });
    expect(success.stdout).toContain('[REDACTED]');
    const failure = await invoke(['me'], { key: fakeCredential, response: json({ error: { message: fakeCredential } }, 403) });
    const network = await invoke(['me'], { key: fakeCredential, fetcher: vi.fn<Fetch>().mockRejectedValue(new Error(`Authorization: Bearer ${fakeCredential}`)) });
    const args = await invoke(['me', `--${fakeCredential}`], { key: fakeCredential });
    for (const result of [success, failure, network, args]) expect(result.stdout + result.stderr).not.toContain(fakeCredential);
    expect(failure.stderr).toContain('HTTP 403');
    expect(network.stderr).toContain('Unable to reach');
  });

  it('requires a key for private reads/writes before any request', async () => {
    const fetcher = vi.fn<Fetch>();
    expect((await invoke(['me'], { fetcher })).code).toBe(1);
    expect((await invoke(['post', 'idea'], { fetcher })).code).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('produces readable output and cursor information by default', async () => {
    const result = await invoke(['ideas', 'search'], { response: json({ items: [{ id: 1, text: 'A concrete idea' }], nextCursor: 'next-page' }) });
    expect(result.stdout).toContain('text: A concrete idea');
    expect(result.stdout).toContain('Next cursor: next-page');
  });

  it('help works without network access', async () => {
    const fetcher = vi.fn<Fetch>();
    const result = await invoke(['--help'], { fetcher });
    expect(result.code).toBe(0); expect(result.stdout).toContain('Usage: wildpi'); expect(fetcher).not.toHaveBeenCalled();
  });

  it('does not accept credential-bearing API URLs', () => {
    const base = new URL('https://api.wildpi.com/v1');
    base.username = 'name'; base.password = 'password';
    expect(() => new ApiClient({ env: { WILDPI_API_BASE: base.href } })).toThrow('without credentials');
  });
});
