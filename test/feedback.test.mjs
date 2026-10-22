import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globMatches, collectFeedback, clusterFeedback } from '../lib/feedback.mjs';

test('globs from the permission matrix', () => {
  assert.ok(globMatches('server/**', 'server/src/app.js'));
  assert.ok(globMatches('web/*.jsx', 'web/App.jsx'));
  assert.ok(!globMatches('web/*.jsx', 'web/pages/App.jsx'));
  assert.ok(globMatches('orchestrator/projects/<id>/messages/<SELF>.json', 'orchestrator/projects/p1/messages/x.json'));
});

const item = (id, occasion, agent, text) => ({ id, occasion, agent, text });

test('the same complaint on two occasions is a repeat', () => {
  const clusters = clusterFeedback([
    item('a', 'p1:0', 'web_agent', 'Do not use inline styles, use the Tailwind dark variants'),
    item('b', 'p2:3', 'web_agent', 'Inline styles again. Use Tailwind dark variants'),
  ]);
  assert.equal(clusters.length, 1);
  assert.deepEqual(clusters[0].items, ['a', 'b']);
  assert.equal(clusters[0].agent, 'web_agent');
});

test('one occasion, another agent, or a different topic is not a repeat', () => {
  const clusters = clusterFeedback([
    item('a', 'p1:0', 'web_agent', 'Inline styles instead of Tailwind dark variants'),
    item('b', 'p1:0', 'web_agent', 'Tailwind dark variants and inline styles again'),
    item('c', 'p2:0', 'api_agent', 'Inline styles are fine in emails, Tailwind dark variants'),
    item('d', 'p3:0', 'web_agent', 'The loading spinner never stops when the fetch fails'),
  ]);
  assert.equal(clusters.length, 0);
});

test('stock reviewer phrasing alone does not make a repeat', () => {
  const clusters = clusterFeedback([
    item('a', 'p1:r', 'web_agent', '[medium] Header.jsx:12 corrective action: element missing aria label, severity medium'),
    item('b', 'p2:r', 'web_agent', '[medium] Table.jsx:40 corrective action: element should paginate rows, severity medium'),
  ]);
  assert.equal(clusters.length, 0);
});

test('reviewer findings are credited to the worker whose files they name', () => {
  const projects = [{
    id: 'p1',
    events: [],
    messages: {
      web_agent: [{ status: 'done', files_touched: ['web/src/Header.jsx'] }],
      reviewer_agent: [{
        approach_summary: 'verdict: changes_requested. Two issues.',
        findings: ['verdict: changes_requested', 'Header.jsx:12 is missing its error state', 'server/src/app.js: route returns 500 on bad input', 'web/x.jsx: PASS'],
      }],
    },
  }];
  const permissions = { matrix: { web_agent: { write: ['web/**'] }, api_agent: { write: ['server/**'] } } };
  const items = collectFeedback({ projects, logged: [{ id: 'f1', text: 'Too many modals', agent: 'web_agent' }], permissions });
  const byText = (s) => items.find((i) => i.text.includes(s));
  assert.equal(byText('Header.jsx').agent, 'web_agent');
  assert.equal(byText('server/src/app.js').agent, 'api_agent');
  assert.equal(byText('Too many modals').source, 'you');
  assert.ok(!items.some((i) => i.text.includes('PASS')));
});
