import { randomUUID } from 'node:crypto';
import { findOperation, type Arguments } from './spec.js';

export interface ApiResponse { data: unknown; status: number; retryAfter?: string }
export type Fetch = typeof globalThis.fetch;
export class ApiError extends Error {
  constructor(public readonly response: ApiResponse) {
    super(response.status === 429
      ? `WildPi rate limit reached (429). Retry-After: ${response.retryAfter ?? 'not provided'}. Stop; no retry was attempted.`
      : response.status === 0 ? 'Unable to reach the WildPi API.' : `WildPi API returned HTTP ${response.status}.`);
  }
}

export class ApiClient {
  private readonly base: string;
  private readonly key: string;
  private readonly fetcher: Fetch;

  constructor(options: { env?: NodeJS.ProcessEnv; fetch?: Fetch } = {}) {
    const env = options.env ?? process.env;
    this.key = env.WILDPI_API_KEY ?? '';
    this.fetcher = options.fetch ?? globalThis.fetch;
    let url: URL;
    try { url = new URL(env.WILDPI_API_BASE || 'https://api.wildpi.com/v1'); }
    catch { throw new Error('WILDPI_API_BASE must be an HTTP(S) URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('WILDPI_API_BASE must be an HTTP(S) URL without credentials, query or fragment.');
    }
    this.base = url.href.replace(/\/+$/, '');
  }

  get hasKey(): boolean { return this.key.length > 0; }

  redact(text: string): string {
    if (!this.key) return text;
    const variants = new Set([this.key, encodeURIComponent(this.key), JSON.stringify(this.key).slice(1, -1)]);
    for (const secret of [...variants].sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]');
    return text;
  }

  scrub(data: unknown): unknown {
    if (typeof data === 'string') return this.redact(data);
    if (Array.isArray(data)) return data.map((value) => this.scrub(value));
    if (data && typeof data === 'object') {
      return Object.fromEntries(Object.entries(data).map(([name, value]) => [this.redact(name), this.scrub(value)]));
    }
    return data;
  }

  async request(operationId: string, args: Arguments = {}, idempotencyKey?: string): Promise<ApiResponse> {
    const { method, operation, path: template } = findOperation(operationId);
    let path = template;
    const query = new URLSearchParams();
    for (const parameter of operation.parameters ?? []) {
      const value = args[parameter.name];
      if (value === undefined) continue;
      if (parameter.in === 'path') path = path.replace(`{${parameter.name}}`, encodeURIComponent(String(value)));
      if (parameter.in === 'query') query.set(parameter.name, String(value));
    }
    if (/\{[^}]+\}/.test(path)) throw new Error('Missing required path argument.');
    const headers = new Headers({ Accept: 'application/json' });
    if (this.key) headers.set('Authorization', `Bearer ${this.key}`);
    if (method !== 'GET') {
      const key = idempotencyKey ?? randomUUID();
      if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new Error('Idempotency key must be 1–128 visible ASCII characters without spaces.');
      headers.set('Idempotency-Key', key);
    }
    const properties = operation.requestBody?.content['application/json'].schema.properties;
    const body = properties ? Object.fromEntries(Object.keys(properties).filter((name) => args[name] !== undefined).map((name) => [name, args[name]])) : undefined;
    if (body) headers.set('Content-Type', 'application/json');
    let response: Response;
    try {
      response = await this.fetcher(`${this.base}${path}${query.size ? `?${query}` : ''}`, {
        method, headers, redirect: 'error', signal: AbortSignal.timeout(20_000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      // Fetch errors can contain URLs, headers or arbitrary server text.
      throw new ApiError({ data: { error: { code: 'network_error', message: 'Unable to reach the WildPi API.' } }, status: 0 });
    }
    let data: unknown = null;
    try { data = response.status === 204 ? null : await response.json(); }
    catch {
      data = { error: { code: 'invalid_response', message: 'The API returned a non-JSON response.' } };
      if (response.ok) throw new ApiError({ data, status: 502 });
    }
    const retryAfter = response.headers.get('Retry-After');
    return { data: this.scrub(data), status: response.status,
      ...(retryAfter ? { retryAfter: this.redact(retryAfter) } : {}) };
  }

  async execute(operationId: string, args: Arguments = {}, idempotencyKey?: string): Promise<unknown> {
    const response = await this.request(operationId, args, idempotencyKey);
    if (response.status >= 400) throw new ApiError(response);
    return response.data;
  }
}
