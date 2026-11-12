import assert from 'node:assert/strict';
import { readFile, realpath, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const json = async (path) => JSON.parse(await readFile(new URL(path, root), 'utf8'));
const marketplace = await json('.claude-plugin/marketplace.json');
const plugin = await json('.claude-plugin/plugin.json');
const mcp = await json('.mcp.json');
assert.equal(marketplace.name, 'wildpi-agent-kit');
assert.equal(marketplace.owner.name, 'WildPi');
assert.deepEqual(marketplace.plugins.map(({ name, source }) => ({ name, source })), [{ name: 'wildpi', source: './' }]);
assert.equal(plugin.name, 'wildpi');
assert.deepEqual(plugin.skills, ['./skills/wildpi']);
assert.equal(plugin.mcpServers, './.mcp.json');
assert.deepEqual(mcp.mcpServers.wildpi, { type: 'http', url: 'https://mcp.wildpi.com/mcp' });
assert.equal(await realpath(new URL(plugin.skills[0], root)), fileURLToPath(new URL('skills/wildpi', root)));
const skill = await readFile(new URL('skills/wildpi/SKILL.md', root), 'utf8');
assert.match(skill, /^---\nname: wildpi\ndescription: (.{1,1023})\n---\n/);
assert.deepEqual((await readdir(new URL('skills/', root))).sort(), ['wildpi']);
// Root is the plugin root: there is only one canonical skill, with no copy to drift.
console.log('Marketplace and plugin share skills/wildpi; remote MCP configuration is valid.');
