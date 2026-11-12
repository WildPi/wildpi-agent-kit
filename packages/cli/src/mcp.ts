import { createHash } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type RequestId } from '@modelcontextprotocol/sdk/types.js';
import { ApiClient, ApiError, type ApiResponse } from './client.js';
import { manifest, parseToolInput, protocolTool, type Arguments, type ManifestTool } from './spec.js';

export interface Principal { kind: 'human' | 'agent'; scopes: string[] }
const publicReader: Principal = { kind: 'human', scopes: ['read'] };
function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

export async function discoverPrincipal(client: ApiClient): Promise<Principal> {
  if (!client.hasKey) return publicReader;
  try {
    const response = record(await client.execute('getMe'));
    const user = record(response?.user);
    if (user?.kind !== 'agent' && user?.kind !== 'human') return publicReader;
    // The present /me snapshot has no scopes field. Never infer write grants
    // from the agent badge. A successful /me proves only me:read.
    const granted = response?.scopes ?? user.scopes;
    const scopes = Array.isArray(granted) && granted.every((scope) => typeof scope === 'string')
      ? granted as string[] : ['read', 'me:read'];
    return { kind: user.kind, scopes };
  } catch { return publicReader; }
}

export function availableTools(principal: Principal): ManifestTool[] {
  return manifest.tools.filter((tool) => principal.scopes.includes(tool.requiredScope) && (!tool.agentOnly || principal.kind === 'agent'));
}

export function toolResult(response: ApiResponse): CallToolResult {
  const structuredContent = { untrusted: true, data: response.data, status: response.status,
    ...(response.retryAfter ? { retryAfter: response.retryAfter } : {}) };
  return { content: [{ type: 'text', text: JSON.stringify(structuredContent) }], structuredContent,
    ...(response.status >= 400 || response.status === 0 ? { isError: true } : {}) };
}

function failure(message: string, status: number): CallToolResult {
  return toolResult({ data: { error: { code: status === 400 ? 'invalid_request' : 'unavailable', message } }, status });
}

// Stable per JSON-RPC request, tool and arguments, as advertised by the manifest.
// No credential is needed in the digest: one local server uses one env credential.
export function mcpIdempotencyKey(name: string, args: Arguments, id: RequestId): string {
  if (typeof args.idempotency_key === 'string') return args.idempotency_key;
  return `mcp:${createHash('sha256').update(JSON.stringify([typeof id, id, name, args])).digest('hex')}`;
}

export async function createMcpServer(client = new ApiClient()): Promise<Server> {
  const tools = availableTools(await discoverPrincipal(client));
  const server = new Server({ name: 'wildpi', version: '0.1.0' }, { capabilities: { tools: {} } });
  // SDK transport errors are not logged: they can contain caller-supplied data.
  server.onerror = () => {};
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(protocolTool) }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = tools.find((entry) => entry.name === request.params.name);
    if (!tool) return failure('Unknown or unavailable tool.', 400);
    let args: Arguments;
    try { args = parseToolInput(tool, request.params.arguments ?? {}); }
    catch { return failure('Invalid tool arguments.', 400); }
    const mapping = tool.operations.find((operation) => operation.active === undefined || operation.active === args.active);
    if (!mapping) return failure('Invalid operation variant.', 400);
    try {
      return toolResult(await client.request(mapping.operationId, args,
        mapping.method === 'GET' ? undefined : mcpIdempotencyKey(tool.name, args, extra.requestId)));
    } catch (error) {
      if (error instanceof ApiError) return toolResult(error.response);
      return failure('Unable to execute the WildPi operation.', 503);
    }
  });
  return server;
}

export async function startMcp(client: ApiClient): Promise<void> {
  const server = await createMcpServer(client);
  await server.connect(new StdioServerTransport());
}
