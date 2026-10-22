import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CORE_ROLES, FEEDBACK_MARKER, coreAgentFile, workerAgentFile, withFeedbackRule, buildCoreMd, buildDomainContextMd, parsePermissionMatrix,
} from '../lib/kit.mjs';
import { globMatches } from '../lib/feedback.mjs';

const workers = [
  { role: 'api_agent', writes: ['server/**'] },
  { role: 'web_agent', writes: ['web/**', 'public/**'] },
];
const allRoles = [...CORE_ROLES, ...workers.map((w) => w.role)];

test('core agent files have every placeholder filled and the feedback rule', () => {
  for (const role of CORE_ROLES) {
    const f = coreAgentFile(role, { prefix: 'acme-', project: 'Acme', workers: workers.map((w) => w.role) });
    assert.match(f.name, /^acme-[a-z-]+\.md$/);
    assert.doesNotMatch(f.text, /\{\{\w+\}\}/);
    assert.match(f.text, new RegExp(`^# IDENTITY: ${role}$`, 'm'));
    assert.ok(f.text.includes(FEEDBACK_MARKER));
  }
});

test('worker agent file lists its write paths', () => {
  const f = workerAgentFile({ prefix: 'acme-', name: 'api-agent', role: 'api_agent', description: 'Builds the API.', purpose: 'You are the API Agent.', writes: ['server/**'] });
  assert.equal(f.name, 'acme-api-agent.md');
  assert.ok(f.text.includes('- ONLY write to `server/**`'));
  assert.doesNotMatch(f.text, /\{\{\w+\}\}/);
});

test('the feedback rule is added once, before the handoff section', () => {
  const text = '# IDENTITY: api_agent\nDo work.\n\n# HANDOFF\nSay done.\n';
  const once = withFeedbackRule(text, 'api_agent');
  assert.ok(once.indexOf(FEEDBACK_MARKER) < once.indexOf('# HANDOFF'));
  assert.equal(withFeedbackRule(once, 'api_agent'), null);
});

test('the generated matrix parses back to the same permissions', () => {
  const agents = Object.fromEntries(allRoles.map((r) => [r, { description: r }]));
  const core = buildCoreMd({ project: 'Acme', agents, workers, constraints: [{ rule: 'Scope by accountId', evidence: 'server/db.js' }] });
  const { matrix, unmapped } = parsePermissionMatrix(core, allRoles);
  assert.deepEqual(unmapped, []);
  assert.ok(matrix.api_agent.write.includes('server/**'));
  assert.deepEqual(matrix.web_agent.write.filter((p) => !p.startsWith('orchestrator/')), ['web/**', 'public/**']);
  assert.deepEqual(matrix.feature_strategist.write, []);
  assert.ok(matrix.lead_agent.write.includes('orchestrator.json'));
  assert.ok(matrix.reviewer_agent.write.includes('orchestrator/research/*.md'));
  assert.ok(!matrix.api_agent.write.includes('web/**'));
  assert.ok(core.includes('Scope by accountId'));
});

test('a design_reviewer column does not steal the reviewer column', () => {
  const md = '| Path | reviewer | design_reviewer |\n|---|---|---|\n| research/*.md | RW | R |\n';
  const { matrix } = parsePermissionMatrix(md, ['design_reviewer_agent', 'reviewer_agent']);
  assert.deepEqual(matrix.reviewer_agent.write, ['research/*.md']);
  assert.deepEqual(matrix.design_reviewer_agent.write, []);
});

test('kit schemas accept any agent role, not a fixed list', async () => {
  const fs = await import('node:fs');
  const read = (f) => JSON.parse(fs.readFileSync(new URL(`../kit/orchestrator/schemas/${f}`, import.meta.url)));
  const status = read('status.schema.json').properties.agents;
  assert.deepEqual(status.required, ['lead_agent']);
  assert.equal(typeof status.additionalProperties, 'object');
  assert.equal(read('task.schema.json').properties.assigned_to.enum, undefined);
  assert.ok(read('agent-message.schema.json').properties.user_feedback);
});

test('domain context assigns modules to the worker that owns them', () => {
  const md = buildDomainContextMd({
    project: 'Acme',
    proposal: { project: { summary: 'S', modules: [{ path: 'server/', what: 'API' }, { path: 'docs/', what: 'Docs' }] } },
    workers,
    matches: globMatches,
  });
  assert.match(md, /\| `server\/` \| API \| api_agent \|/);
  assert.match(md, /\| `docs\/` \| Docs \|  \|/);
});
