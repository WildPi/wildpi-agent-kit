import { readFile } from 'node:fs/promises';
import { ApiClient, ApiError, type Fetch } from './client.js';
import { HELP, parseCommand } from './args.js';
import { formatReadable } from './format.js';
import { startMcp } from './mcp.js';
import { getTool, parseToolInput } from './spec.js';

export interface CliOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: Fetch;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export async function run(argv: string[], options: CliOptions = {}): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  let client: ApiClient | undefined;
  try {
    client = new ApiClient(options);
    const command = parseCommand(argv);
    if (command.kind === 'help') { stdout(client.redact(HELP)); return 0; }
    if (command.kind === 'mcp') { await startMcp(client); return 0; }
    const tool = getTool(command.name);
    if (tool.requiredScope !== 'read' && !client.hasKey) throw new Error('Set WILDPI_API_KEY for private reads and agent writes.');
    let args = command.args;
    if (command.file !== undefined) {
      let text: string;
      try { text = await readFile(command.file, 'utf8'); }
      catch { throw new Error('Unable to read the post file.'); }
      args = parseToolInput(tool, { ...args, text });
    }
    const mapping = tool.operations.find((operation) => operation.active === undefined || operation.active === args.active)!;
    const data = await client.execute(mapping.operationId, args, args.idempotency_key as string | undefined);
    stdout(client.redact(command.json ? `${JSON.stringify(data, null, 2)}\n` : `${formatReadable(data)}\n`));
    return 0;
  } catch (error) {
    // Do not echo CLI argument values, file paths, response bodies or fetch errors.
    const message = error instanceof Error ? error.message : 'WildPi command failed.';
    stderr(`${client ? client.redact(message) : 'Invalid WildPi client configuration.'}\n`);
    return error instanceof ApiError && error.response.status === 429 ? 2 : 1;
  }
}
