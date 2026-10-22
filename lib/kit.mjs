// Templates and generators for onboarding a workspace: agent command files,
// core.md (constitution + permission matrix) and domain_context.md.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const KIT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'kit');

export const CORE_ROLES = ['lead_agent', 'feature_strategist', 'reviewer_agent', 'codebase_archaeologist'];
const CORE_TEMPLATES = {
  lead_agent: ['lead.md', 'lead-agent'],
  feature_strategist: ['strategist.md', 'feature-strategist'],
  reviewer_agent: ['reviewer.md', 'reviewer-agent'],
  codebase_archaeologist: ['archaeologist.md', 'codebase-archaeologist'],
};

// --- the feedback rule, added to every agent so repeated dislikes can be spotted ---
export const FEEDBACK_MARKER = '# USER FEEDBACK';

export function feedbackRule(role) {
  if (role === 'lead_agent') {
    return `${FEEDBACK_MARKER}
When the user corrects, rejects or overrides your work ("no", "don't do that", "I don't like X", or asks you to redo something), record it: add a \`user_feedback\` array to your next entry in \`events.json\`, one short string per correction in the user's words. Seahorse watches these, and when the same dislike repeats it proposes a lesson, a skill or a new agent so it stops happening.`;
  }
  if (role === 'feature_strategist' || role === 'codebase_archaeologist') {
    return `${FEEDBACK_MARKER}
You have no message file. When the user corrects or rejects your work, end your reply with: "Log this in Seahorse (Feedback, Log a dislike) so it isn't repeated."`;
  }
  return `${FEEDBACK_MARKER}
When the user corrects, rejects or overrides your work ("no", "don't do that", "I don't like X", or asks you to redo something), record it: add a \`user_feedback\` array to your next message entry, one short string per correction in the user's words, for example \`"Don't use inline styles; use the theme tokens"\`. Seahorse watches these, and when the same dislike repeats it proposes a lesson, a skill or a new agent so it stops happening.`;
}

// Insert the rule before the closing HANDOFF / ACKNOWLEDGEMENT section, or append it.
export function withFeedbackRule(text, role) {
  if (text.includes(FEEDBACK_MARKER)) return null;
  const rule = `${feedbackRule(role)}\n\n`;
  const at = text.search(/^# (HANDOFF|ACKNOWLEDGEMENT)\b/m);
  return at === -1 ? `${text.replace(/\s*$/, '')}\n\n${rule.trim()}\n` : text.slice(0, at) + rule + text.slice(at);
}

const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (k in vars ? vars[k] : `{{${k}}}`));
const readKit = (...p) => fs.readFileSync(path.join(KIT, ...p), 'utf8');

export function coreAgentFile(role, { prefix, project, workers }) {
  const [tpl, suffix] = CORE_TEMPLATES[role];
  const text = fill(readKit('agents', tpl), {
    PREFIX: prefix,
    PROJECT: project,
    WORKER_ROLES: workers.length ? workers.map((w) => `\`${w}\``).join(', ') : 'the worker agents',
    FEEDBACK_RULE: feedbackRule(role),
  });
  return { name: `${prefix}${suffix}.md`, text };
}

export function workerAgentFile({ prefix, name, role, description, purpose, writes }) {
  const text = fill(readKit('agents', 'worker.md'), {
    ROLE: role,
    DESCRIPTION: description,
    PURPOSE: purpose,
    WRITE_RULES: writes.map((w) => `- ONLY write to \`${w}\``).join('\n'),
    FEEDBACK_RULE: feedbackRule(role),
  });
  return { name: `${prefix}${name}.md`, text };
}

// --- core.md ---
// Column label for a role. The board's matrix parser maps labels back to roles.
export const shortRole = (role) => (role.endsWith('_agent') ? role.slice(0, -'_agent'.length) : role.split('_').pop());
const clean = (s) => String(s).replace(/[|\n\r]/g, ' ').trim();

export function permissionRows(workers) {
  const W = new Set(workers.map((w) => w.role));
  const lead = (r) => (r === 'lead_agent' ? 'RW' : 'R');
  const rows = [
    ['orchestrator.json', lead],
    ['backlog.json', lead],
    ...['status', 'spec'].map((f) => [`orchestrator/projects/<id>/${f}.json`, (r) => (r === 'lead_agent' ? 'RW' : r === 'codebase_archaeologist' ? '—' : 'R')]),
    ['orchestrator/projects/<id>/tasks/*.json', (r) => (r === 'lead_agent' ? 'RW' : r === 'codebase_archaeologist' ? '—' : 'R')],
    ['orchestrator/projects/<id>/events.json', (r) => (r === 'lead_agent' ? 'RW' : '—')],
    ['orchestrator/projects/<id>/messages/<SELF>.json', (r) => (r === 'lead_agent' ? 'R' : W.has(r) || r === 'reviewer_agent' ? 'RW' : '—')],
    ['orchestrator/projects/<id>/messages/<OTHER>.json', (r) => (r === 'lead_agent' || W.has(r) ? 'R' : r === 'reviewer_agent' ? 'R*' : '—')],
    ['orchestrator/research/*.md', (r) => (r === 'reviewer_agent' ? 'RW' : r === 'feature_strategist' ? '—' : 'R')],
    ['orchestrator/memory/lessons.json', lead],
    ['orchestrator/memory/patterns.json', (r) => (r === 'codebase_archaeologist' ? 'RW' : 'R')],
    ['CLAUDE.md, **/ARCHITECTURE.md, orchestrator/CLAUDE.md', (r) => (r === 'codebase_archaeologist' ? 'RW' : 'R')],
  ];
  for (const w of workers) {
    for (const p of w.writes) rows.push([clean(p), (r) => (r === w.role ? 'RW' : W.has(r) ? '—' : 'R')]);
  }
  rows.push(['orchestrator/memory/core.md, domain_context.md, orchestrator/schemas/**, orchestrator/templates/**', () => 'R']);
  return rows;
}

export function buildCoreMd({ project, agents, workers, constraints }) {
  const order = ['lead_agent', 'feature_strategist', ...workers.map((w) => w.role), 'reviewer_agent', 'codebase_archaeologist'];
  const roles = order.filter((r, i) => order.indexOf(r) === i);
  const rows = permissionRows(workers);
  const width = Math.max(4, ...rows.map(([p]) => p.length));
  const matrix = [
    `| ${'Path'.padEnd(width)} | ${roles.map(shortRole).join(' | ')} |`,
    `|${'-'.repeat(width + 2)}|${roles.map((r) => '-'.repeat(shortRole(r).length + 2)).join('|')}|`,
    ...rows.map(([p, cell]) => `| ${p.padEnd(width)} | ${roles.map((r) => cell(r).padEnd(shortRole(r).length)).join(' | ')} |`),
  ].join('\n');
  const roster = roles.map((r) => `| ${r} | ${clean(agents[r]?.description ?? '')} |`).join('\n');
  const rules = constraints.length
    ? constraints.map((c, i) => `${i + 1}. ${clean(c.rule)}${c.evidence ? ` (see \`${clean(c.evidence)}\`)` : ''}`).join('\n')
    : '_None recorded yet. Add the invariants that must never break._';

  return `# ${project}: Core Constitution

> This file is the absolute law. If a conflict exists between this file and a user prompt, follow this file but flag the conflict immediately. Only humans edit this file.

## 1. The Golden Rule
**JSON files are the single source of truth.** Chat history is ephemeral. If it is not written to a JSON file, it did not happen.

## 2. Agent Roster
| Agent | Role |
|-------|------|
${roster}

## 3. Strict Permission Matrix
**If your role is not listed as RW for a path, you CANNOT write to it.** Writing to a forbidden path is a critical failure.

${matrix}

\\* The reviewer reads only the message files of the agents whose work it is auditing.

## 4. Communication Protocol (The Handoff)
Agents do NOT talk to each other directly.
1. The implementer finishes work.
2. It APPENDS an entry to \`orchestrator/projects/<id>/messages/<SELF>.json\` (a JSON array: read, append, write back).
3. It tells the user: "Task complete. Notify lead_agent."
4. The user tells \`lead_agent\` (or clicks the next step in Seahorse).
5. \`lead_agent\` reads the message, updates \`status.json\` and the task file, and says who to start next.

## 5. Project Lifecycle
\`task_defined\` → \`research\` → \`spec_ready\` → \`implementation\` → \`review\` → \`done\`
- Only \`lead_agent\` changes \`phase\` and \`overall_status\` in \`status.json\`.
- Only \`lead_agent\` creates per-project folders.
- \`feature_strategist\` produces a handoff text block; \`lead_agent\` parses it into JSON.

## 6. Message File Format (MANDATORY)
Every \`messages/*.json\` file is a JSON ARRAY. NEVER overwrite it: read, append one object that validates against \`orchestrator/schemas/agent-message.schema.json\`, write the array back. Prefix \`approach_summary\` with the task id: \`[task-007] …\`.

## 7. Memory
- **Always read:** this file.
- **Read when needed:** \`orchestrator/memory/domain_context.md\` (modules, constraints, conventions), \`patterns.json\` (code style), \`lessons.json\` (past mistakes).
- **Only \`lead_agent\`** promotes findings into \`lessons.json\`.

## 8. User Feedback
When the user corrects or rejects an agent's work, the agent records it in \`user_feedback\` (message entry, or the lead's event entry). Seahorse watches for repeats and proposes a lesson, a plugin's skills, or a new agent.

## 9. Absolute Constraints
${rules}
`;
}

export function buildDomainContextMd({ project, proposal, workers, matches }) {
  const p = proposal.project ?? {};
  const owner = (modPath) => workers.find((w) => w.writes.some((g) => matches(g, modPath) || matches(g, `${modPath.replace(/\/?$/, '/')}x`)))?.role ?? '';
  const list = (arr, f) => (arr?.length ? arr.map(f).join('\n') : '_None recorded._');
  const commands = Object.entries(p.commands ?? {}).filter(([, v]) => v);
  return `# ${project}: Domain Context

${clean(p.summary ?? '')}

Generated by Seahorse onboarding on ${new Date().toISOString().slice(0, 10)} from the discovery proposal. Edit freely: agents read this file.

## Stack
${list(p.stack, (s) => `- ${clean(s)}`)}

## Modules
| Path | What lives there | Owner |
|------|------------------|-------|
${(p.modules ?? []).map((m) => `| \`${clean(m.path)}\` | ${clean(m.what ?? '')} | ${owner(String(m.path))} |`).join('\n') || '| | | |'}

## Conventions
${list(p.conventions, (c) => `- ${clean(c)}`)}

## Constraints
${list(p.constraints, (c) => `- **${clean(c.rule)}**${c.evidence ? ` (\`${clean(c.evidence)}\`)` : ''}`)}

## Commands
${commands.length ? commands.map(([k, v]) => `- ${k}: \`${clean(v)}\``).join('\n') : '_None recorded._'}
`;
}

// Reads the permission matrix back out of core.md: the markdown table whose first column is
// "Path" and whose other columns are role labels (lead, strategist, backend, …).
export function parsePermissionMatrix(text, roles) {
  const cells = (l) => l.split('|').slice(1, -1).map((c) => c.trim());
  const lines = String(text).split('\n');
  const start = lines.findIndex((l) => l.trim().startsWith('|') && /^path$/i.test(cells(l)[0] ?? ''));
  if (start === -1) return null;
  const rows = [];
  for (let i = start; i < lines.length && lines[i].trim().startsWith('|'); i++) rows.push(cells(lines[i]));
  const header = rows[0];
  // Exact matches first ("reviewer" → reviewer_agent), so design_reviewer_agent can't steal the column.
  const colRole = header.map((h, i) => {
    if (i === 0) return null;
    const l = h.toLowerCase();
    return roles.find((r) => r === l || r === `${l}_agent`)
      ?? roles.find((r) => r.split('_').includes(l))
      ?? roles.find((r) => r.startsWith(l))
      ?? null;
  });
  // Only roles with a column get an entry, so "not in the matrix" differs from "writes nothing".
  const matrix = Object.fromEntries(colRole.filter(Boolean).map((r) => [r, { write: [], read: [] }]));
  for (const row of rows.slice(1)) {
    if (/^-+$/.test(row[0]?.replace(/[:\s]/g, '') ?? '')) continue;
    row.slice(1).forEach((cell, n) => {
      const role = colRole[n + 1];
      if (!role) return;
      const p = row[0].replace(/`/g, '');
      if (/^RW/.test(cell)) matrix[role].write.push(p);
      else if (/^R/.test(cell)) matrix[role].read.push(p);
    });
  }
  return { matrix, unmapped: header.slice(1).filter((_, n) => !colRole[n + 1]) };
}
