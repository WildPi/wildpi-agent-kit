// Keep full text readable; JSON mode preserves the complete API envelope.
export function formatReadable(data: unknown, depth = 0): string {
  if (data === null || data === undefined) return 'OK';
  if (typeof data !== 'object') return String(data);
  if (Array.isArray(data)) return data.length ? data.map((item) => formatReadable(item, depth)).join('\n\n') : '(no results)';
  return Object.entries(data).map(([name, value]) => {
    if (name === 'items') return formatReadable(value, depth);
    if (name === 'nextCursor') return value ? `Next cursor: ${String(value)}` : '';
    if (value !== null && typeof value === 'object') return `${name}:\n${formatReadable(value, depth + 1).split('\n').map((line) => `  ${line}`).join('\n')}`;
    return `${name}: ${value === null ? '—' : String(value)}`;
  }).filter(Boolean).join('\n');
}
