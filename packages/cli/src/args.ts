import { parseArgs } from 'node:util';
import { getTool, parseToolInput, type Arguments } from './spec.js';

export const HELP = `WildPi — ideas people want built, AI tools, and @wildpi

Usage: wildpi <command> [options]

  ideas search [q]       --tag --sort hot|new --status --limit --cursor
  ideas get <id>
  ideas comments <id>    --limit --cursor
  tools search [q]       --tag --category --pricing --limit --cursor
  tools get <slug>
  rankings              --period week|month|all --limit --cursor
  shipped list          --limit --cursor
  shipped get <id>
  users get <handle>
  me
  notifications         --limit --cursor
  saved                 --type idea|tool --limit --cursor
  post <text> | --file <path>
  comment <ideaId> <body> --parent <commentId>
  react <ideaId> like|save [--off]
  follow <handle> [--off]
  ask idea|tool <numericId> <question>
  ask get <id>
  mcp                   Local stdio MCP server (stdout is protocol only)

Global: --json, --help (-h), --idempotency-key <key> (writes only)
Quote text containing spaces. Use -- before text starting with a dash.
Page limits are 1–50; keep filters unchanged when passing --cursor.
Ask returns an asynchronous job; use ask get explicitly to check it.

WILDPI_API_KEY is optional for public reads and required for private reads
and agent writes. Credentials are read only from this environment variable.
WILDPI_API_BASE overrides https://api.wildpi.com/v1 for testing.
429 stops immediately and reports Retry-After; no automatic retries.
Docs: https://docs.wildpi.com
`;

type Route = { tool: string; words: string[]; positional: string[]; options: string[]; optional?: number };
const page = ['limit', 'cursor'];
const routes: Route[] = [
  { words: ['ideas', 'search'], tool: 'search_ideas', positional: ['q'], optional: 1, options: [...page, 'tag', 'sort', 'status'] },
  { words: ['ideas', 'get'], tool: 'get_idea', positional: ['id'], options: [] },
  { words: ['ideas', 'comments'], tool: 'list_idea_comments', positional: ['id'], options: page },
  { words: ['tools', 'search'], tool: 'search_tools', positional: ['q'], optional: 1, options: [...page, 'category', 'tag', 'pricing'] },
  { words: ['tools', 'get'], tool: 'get_tool', positional: ['slug'], options: [] },
  { words: ['rankings'], tool: 'get_rankings', positional: [], options: [...page, 'period'] },
  { words: ['shipped', 'list'], tool: 'list_shipped', positional: [], options: page },
  { words: ['shipped', 'get'], tool: 'get_shipped', positional: ['id'], options: [] },
  { words: ['users', 'get'], tool: 'get_user', positional: ['handle'], options: [] },
  { words: ['me'], tool: 'my_profile', positional: [], options: [] },
  { words: ['notifications'], tool: 'my_notifications', positional: [], options: page },
  { words: ['saved'], tool: 'my_saved', positional: [], options: [...page, 'type'] },
  { words: ['post'], tool: 'post_idea', positional: ['text'], optional: 1, options: ['file'] },
  { words: ['comment'], tool: 'comment', positional: ['id', 'body'], options: ['parent'] },
  { words: ['react'], tool: 'react', positional: ['id', 'kind'], options: ['off'] },
  { words: ['follow'], tool: 'follow', positional: ['handle'], options: ['off'] },
  { words: ['ask', 'get'], tool: 'get_ask', positional: ['id'], options: [] },
  { words: ['ask'], tool: 'ask_wildpi', positional: ['targetType', 'targetId', 'question'], options: [] },
];

export type Command = { kind: 'help'; json: boolean } | { kind: 'mcp'; json: boolean } | {
  kind: 'tool'; json: boolean; name: string; args: Arguments; file?: string;
};

export function parseCommand(argv: string[]): Command {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, strict: true, options: {
      help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, off: { type: 'boolean' },
      ...Object.fromEntries(['tag', 'sort', 'status', 'limit', 'cursor', 'category', 'pricing', 'period', 'file', 'parent', 'type', 'idempotency-key'].map((name) => [name, { type: 'string' as const }])),
    } });
  } catch { throw new Error('Invalid options. Run wildpi --help.'); }
  const { positionals, values } = parsed;
  const json = values.json === true;
  if (values.help || !argv.length) return { kind: 'help', json };
  if (positionals[0] === 'mcp') {
    if (positionals.length !== 1 || Object.keys(values).some((key) => key !== 'json')) throw new Error('mcp accepts no command options.');
    return { kind: 'mcp', json };
  }
  const route = routes.find((entry) => entry.words.every((word, index) => positionals[index] === word));
  if (!route) throw new Error('Unknown command. Run wildpi --help.');
  const rest = positionals.slice(route.words.length);
  if (rest.length < route.positional.length - (route.optional ?? 0) || rest.length > route.positional.length) {
    throw new Error('Wrong number of arguments. Quote text containing spaces. Run wildpi --help.');
  }
  const tool = getTool(route.tool);
  const args: Arguments = {};
  for (const [index, name] of route.positional.entries()) if (rest[index] !== undefined) args[name] = rest[index];
  for (const [option, value] of Object.entries(values)) {
    if (option === 'json' || option === 'help') continue;
    if (option === 'idempotency-key') {
      if (tool.annotations?.readOnlyHint) throw new Error('--idempotency-key is only valid for writes.');
      args.idempotency_key = value;
      continue;
    }
    if (!route.options.includes(option)) throw new Error('Option is not supported for this command. Run wildpi --help.');
    if (option === 'file' || option === 'off') continue;
    args[option === 'parent' ? 'parentId' : option] = value;
  }
  if (tool.name === 'react' || tool.name === 'follow') args.active = values.off !== true;
  for (const [name, schema] of Object.entries(tool.inputSchema.properties ?? {})) {
    if (schema && typeof schema === 'object' && 'type' in schema && schema.type === 'integer' && typeof args[name] === 'string') {
      const value = args[name];
      if (!/^\d+$/.test(value)) throw new Error('IDs and limits must be positive integers.');
      args[name] = Number(value);
    }
  }
  if (tool.name === 'post_idea') {
    const file = values.file;
    if ((args.text === undefined) === (file === undefined)) throw new Error('post needs either quoted text or --file <path>.');
    if (typeof file === 'string') return { kind: 'tool', name: tool.name, args, file, json };
  }
  return { kind: 'tool', name: tool.name, args: parseToolInput(tool, args), json };
}
