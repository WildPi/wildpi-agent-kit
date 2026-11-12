import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const cases = JSON.parse(await readFile(new URL('../skills/wildpi/evals/cases.json', import.meta.url), 'utf8'));
assert.equal(cases.length, 15);
assert.equal(new Set(cases.map(({ id }) => id)).size, cases.length);
for (const item of cases) {
  assert.equal(typeof item.id, 'string');
  assert.equal(typeof item.prompt, 'string');
  assert.ok(item.context && typeof item.context === 'object');
  assert.equal(typeof item.expected.trigger, 'boolean');
  assert.equal(typeof item.expected.approval_required, 'boolean');
  for (const name of ['required_actions', 'forbidden_actions', 'success_criteria']) {
    assert.ok(Array.isArray(item.expected[name]));
    assert.ok(item.expected[name].every((value) => typeof value === 'string'));
  }
}
assert.ok(cases.filter(({ expected }) => !expected.trigger).length >= 3);
for (const workflow of ['wanted-idea', 'recommend-tools', 'draft-post', 'ask-wildpi']) assert.ok(cases.some(({ expected }) => expected.workflow === workflow));
console.log('15 eval fixtures valid (behavioral model evaluation is manual; see evals/README.md).');
