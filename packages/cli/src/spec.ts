import { readFileSync } from 'node:fs';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

export type Arguments = Record<string, unknown>;
export interface Parameter {
  name: string;
  in: 'path' | 'query' | 'header';
  required?: boolean;
  schema?: Record<string, unknown>;
}
export interface Operation {
  operationId: string;
  parameters?: Parameter[];
  requestBody?: { content: { 'application/json': { schema: { properties: Arguments } } } };
}
export interface OpenApi {
  paths: Record<string, Record<string, Operation>>;
}
export interface Mapping {
  operationId: string;
  method: string;
  path: string;
  active?: boolean;
  parameters: Pick<Parameter, 'name' | 'in'>[];
  bodyProperties?: string[];
}
export interface ManifestTool extends Tool {
  operationId: string;
  operations: Mapping[];
  requiredScope: string;
  agentOnly: boolean;
}

export const openapi = JSON.parse(readFileSync(new URL('../spec/openapi.json', import.meta.url), 'utf8')) as OpenApi;
export const manifest = JSON.parse(readFileSync(new URL('../spec/mcp-tools.json', import.meta.url), 'utf8')) as { tools: ManifestTool[] };

export function findOperation(operationId: string): { method: string; path: string; operation: Operation } {
  for (const [path, methods] of Object.entries(openapi.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      if (operation.operationId === operationId) return { method: method.toUpperCase(), path, operation };
    }
  }
  throw new Error('Operation is missing from the API snapshot.');
}

// Check both snapshots together; the manifest chooses variants, OpenAPI owns HTTP routing.
for (const tool of manifest.tools) {
  for (const mapping of tool.operations) {
    const { method, path } = findOperation(mapping.operationId);
    if (method !== mapping.method || `/v1${path}` !== mapping.path) {
      throw new Error('MCP manifest and API snapshot disagree. Run npm run spec:update.');
    }
  }
}

const inputs = new Map(manifest.tools.map((tool) => {
  const schema = structuredClone(tool.inputSchema) as z.core.JSONSchema.JSONSchema;
  // Match the remote validator: the JSON Schema importer does not preserve the
  // Unicode flag on tag patterns. The API still enforces its original pattern.
  for (const property of Object.values(schema.properties ?? {})) {
    if (property && typeof property === 'object' && 'pattern' in property &&
        typeof property.pattern === 'string' && /\\[pP]\{/.test(property.pattern)) {
      delete property.pattern;
    }
  }
  return [tool.name, z.fromJSONSchema(schema)] as const;
}));

export function parseToolInput(tool: ManifestTool, args: Arguments): Arguments {
  const result = inputs.get(tool.name)!.safeParse(args);
  if (!result.success) throw new Error('Invalid arguments. Check --help and the API reference.');
  return result.data as Arguments;
}

export function getTool(name: string): ManifestTool {
  const tool = manifest.tools.find((entry) => entry.name === name);
  if (!tool) throw new Error('Unknown WildPi tool.');
  return tool;
}

export function protocolTool({ name, description, inputSchema, annotations }: ManifestTool): Tool {
  return { name, ...(description === undefined ? {} : { description }), inputSchema,
    ...(annotations === undefined ? {} : { annotations }) };
}
