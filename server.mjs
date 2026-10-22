#!/usr/bin/env node
// Seahorse: live board for an orchestrator workspace.
// It never writes orchestrator files (those belong to the agents). Its actions are:
// opening an agent in a new terminal window, installing plugins through the claude CLI,
// writing its own config in <workspace>/.seahorse/, and creating new agent command files.
// Usage: seahorse [workspace-path]   (default: the current folder)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KIT, CORE_ROLES, FEEDBACK_MARKER, withFeedbackRule, coreAgentFile, workerAgentFile, buildCoreMd, buildDomainContextMd,
  parsePermissionMatrix,
} from './lib/kit.mjs';
import { collectFeedback, clusterFeedback, globMatches } from './lib/feedback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(process.argv[2] || process.env.WORKSPACE || process.cwd());
const ORCH = path.join(WORKSPACE, 'orchestrator');
const COMMANDS = path.join(WORKSPACE, '.claude', 'commands');
const PORT = Number(process.env.PORT) || 4600;
const HOST = '127.0.0.1';

if (!fs.existsSync(WORKSPACE) || !fs.statSync(WORKSPACE).isDirectory()) {
  console.error(`${WORKSPACE} is not a folder.`);
  console.error('Usage: node server.mjs <path-to-workspace>');
  process.exit(1);
}
// A workspace without orchestrator.json opens in onboarding mode.
const isConfigured = () => fs.existsSync(path.join(WORKSPACE, 'orchestrator.json'));

// Agents rewrite JSON files in place; a read can land mid-write.
// Keep the last good parse per file so the board never blanks out.
const lastGood = new Map();
const errors = [];

function readJson(file, fallback = null) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    lastGood.set(file, value);
    return value;
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    errors.push({ file: path.relative(WORKSPACE, file), error: err.message });
    return lastGood.has(file) ? lastGood.get(file) : fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(`${file}.tmp`, file);
}

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

function loadProject(id) {
  const dir = path.join(ORCH, 'projects', id);
  const messages = {};
  for (const f of listJson(path.join(dir, 'messages'))) {
    messages[f.replace(/\.json$/, '')] = readJson(path.join(dir, 'messages', f), []);
  }
  return {
    id,
    status: readJson(path.join(dir, 'status.json')),
    spec: readJson(path.join(dir, 'spec.json')),
    events: readJson(path.join(dir, 'events.json'), []),
    tasks: listJson(path.join(dir, 'tasks')).map((f) => readJson(path.join(dir, 'tasks', f))).filter(Boolean),
    messages,
    hasReview: fs.existsSync(path.join(ORCH, 'research', `review-${id}.md`)),
  };
}

// --- agents ---
// An agent is any .claude/commands/*.md file with an "# IDENTITY: <role>" line.
// Files without one fall back to the classic role suffixes (…-lead-agent.md etc.).
const ROLE_SUFFIXES = {
  lead_agent: 'lead-agent',
  feature_strategist: 'feature-strategist',
  backend_agent: 'backend-agent',
  frontend_agent: 'frontend-agent',
  reviewer_agent: 'reviewer-agent',
  codebase_archaeologist: 'codebase-archaeologist',
};

function discoverAgents() {
  const agents = {};
  let names = [];
  try { names = fs.readdirSync(COMMANDS).filter((n) => n.endsWith('.md')).sort(); } catch {}
  for (const name of names) {
    const cmd = name.replace(/\.md$/, '');
    let text = '';
    try { text = fs.readFileSync(path.join(COMMANDS, name), 'utf8'); } catch { continue; }
    let role = text.match(/^#\s*IDENTITY:\s*([a-z0-9_]+)/im)?.[1];
    if (!role) role = Object.entries(ROLE_SUFFIXES).find(([, s]) => cmd === s || cmd.endsWith(`-${s}`))?.[0];
    if (!role || agents[role]) continue;
    agents[role] = {
      role,
      command: `/${cmd}`,
      file: path.relative(WORKSPACE, path.join(COMMANDS, name)),
      description: text.match(/^---[\s\S]*?^description:\s*(.+)$[\s\S]*?^---/m)?.[1]?.trim() ?? '',
      lines: text.split('\n').length,
      feedbackRule: text.includes(FEEDBACK_MARKER),
    };
  }
  return agents;
}

// The permission matrix in core.md: a markdown table whose first column is "Path"
// and whose other columns are role names (lead, strategist, backend, …).
function permissionMatrix(agents) {
  let text = '';
  try { text = fs.readFileSync(path.join(ORCH, 'memory', 'core.md'), 'utf8'); } catch { return null; }
  return parsePermissionMatrix(text, Object.keys(agents));
}

// --- Seahorse's own config (never an orchestrator file) ---
// reminders.json: { "<role>": ["L020"] }   skills.json: { "<role>": ["plugin@marketplace"] }
const SEAHORSE_DIR = path.join(WORKSPACE, '.seahorse');
function readConfig(name) {
  const data = readJson(path.join(SEAHORSE_DIR, name), {});
  return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
}
function toggleInConfig(name, role, value, on) {
  const all = readConfig(name);
  const set = new Set(Array.isArray(all[role]) ? all[role] : []);
  on === true ? set.add(value) : set.delete(value);
  all[role] = [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!all[role].length) delete all[role];
  writeJsonAtomic(path.join(SEAHORSE_DIR, name), all);
  notify();
  return all;
}

const lessonList = () => {
  const data = readJson(path.join(ORCH, 'memory', 'lessons.json'), { lessons: [] });
  return Array.isArray(data) ? data : data.lessons ?? [];
};

function loadState() {
  errors.length = 0;
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(ORCH, 'projects'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {}
  const agents = discoverAgents();
  const projects = ids.map(loadProject);
  const permissions = permissionMatrix(agents);
  const feedbackItems = collectFeedback({ projects, logged: readLogged(), permissions });
  return {
    workspace: path.basename(WORKSPACE),
    configured: isConfigured(),
    loadedAt: new Date().toISOString(),
    orchestrator: readJson(path.join(WORKSPACE, 'orchestrator.json'), {}),
    backlog: readJson(path.join(WORKSPACE, 'backlog.json'), { items: [] }),
    lessons: readJson(path.join(ORCH, 'memory', 'lessons.json'), { lessons: [] }),
    projects,
    agents: Object.fromEntries(Object.entries(agents).map(([role, a]) => [role, a.command])),
    agentInfo: agents,
    permissions,
    reminders: readConfig('reminders.json'),
    skills: readConfig('skills.json'),
    feedback: { items: feedbackItems, clusters: clusterFeedback(feedbackItems), schemaReady: schemaAcceptsFeedback() },
    proposals: readProposals(),
    onboarding: onboardingState(),
    errors: [...errors],
  };
}

// --- feedback, proposals ---
const readLogged = () => {
  const data = readJson(path.join(SEAHORSE_DIR, 'feedback.json'), []);
  return Array.isArray(data) ? data.filter((f) => f && typeof f.text === 'string') : [];
};

const MESSAGE_SCHEMA = path.join(ORCH, 'schemas', 'agent-message.schema.json');
function schemaAcceptsFeedback() {
  const s = readJson(MESSAGE_SCHEMA, null);
  return !s || s.additionalProperties !== false || !!s.properties?.user_feedback;
}

function readProposals() {
  const list = readJson(path.join(SEAHORSE_DIR, 'proposals.json'), []);
  const status = readConfig('proposal-status.json');
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && typeof p.id === 'string' && ['lesson', 'plugin', 'agent'].includes(p.kind))
    .map((p) => ({ ...p, status: status[p.id] ?? 'open' }));
}

function logFeedback({ agent, project, text, remove }) {
  const file = path.join(SEAHORSE_DIR, 'feedback.json');
  let list = readLogged();
  if (remove) {
    list = list.filter((f) => f.id !== remove);
  } else {
    const t = String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!t) throw new Error('Write what you didn\'t like');
    if (agent && !discoverAgents()[agent]) throw new Error(`Unknown agent ${agent}`);
    if (project && !ID_RE.test(String(project))) throw new Error('Invalid project');
    list.push({ id: `f${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`, when: new Date().toISOString(), agent: agent || null, project: project || null, text: t });
  }
  writeJsonAtomic(file, list);
  notify();
  return { ok: true };
}

// Adds the feedback rule to every agent file that lacks it, and lets the message schema accept user_feedback.
function setupFeedback() {
  const changed = [];
  for (const a of Object.values(discoverAgents())) {
    const file = path.join(WORKSPACE, a.file);
    const next = withFeedbackRule(fs.readFileSync(file, 'utf8'), a.role);
    if (next) { fs.writeFileSync(file, next); changed.push(a.file); }
  }
  const schema = readJson(MESSAGE_SCHEMA, null);
  if (schema?.properties && !schema.properties.user_feedback) {
    schema.properties.user_feedback = { type: 'array', items: { type: 'string' }, description: 'Corrections or rejections the user gave during this work, one short string each, in the user\'s words.' };
    writeJsonAtomic(MESSAGE_SCHEMA, schema);
    changed.push(path.relative(WORKSPACE, MESSAGE_SCHEMA));
  }
  notify();
  return { changed };
}

function setProposalStatus({ id, status }) {
  if (!readProposals().some((p) => p.id === id)) throw new Error(`Proposal ${id} not found`);
  if (!['accepted', 'dismissed', 'open'].includes(status)) throw new Error('Unknown status');
  const all = readConfig('proposal-status.json');
  if (status === 'open') delete all[id]; else all[id] = status;
  writeJsonAtomic(path.join(SEAHORSE_DIR, 'proposal-status.json'), all);
  notify();
  return { ok: true };
}

// Installs one of Seahorse's own commands into the workspace so it can be run as a slash command.
function installKitCommand(name) {
  fs.mkdirSync(COMMANDS, { recursive: true });
  fs.copyFileSync(path.join(KIT, 'commands', `${name}.md`), path.join(COMMANDS, `${name}.md`));
}

async function startReflect({ cluster }) {
  const state = loadState();
  const c = state.feedback.clusters.find((x) => x.id === cluster);
  if (!c) throw new Error('That group of feedback no longer exists');
  const items = state.feedback.items.filter((i) => c.items.includes(i.id));
  const roles = [...new Set(items.map((i) => i.agent).filter(Boolean))];
  let market = { installed: [], available: [] };
  try { market = await catalog(); } catch {}
  writeJsonAtomic(path.join(SEAHORSE_DIR, 'reflect', 'input.json'), {
    cluster: { id: c.id, label: c.label, agent: c.agent, items },
    agents: Object.values(state.agentInfo).map((a) => ({ role: a.role, command: a.command, file: a.file, description: a.description, involved: roles.includes(a.role) })),
    lessons: lessonList().map((l) => ({ id: l.id, title: l.title, status: l.status ?? 'active' })),
    installed_plugins: market.installed.map((p) => p.pluginId ?? p.id ?? p.name),
    catalog: market.available.map((p) => ({ pluginId: p.pluginId, description: p.description, category: p.category ?? null })),
  });
  installKitCommand('seahorse-reflect');
  return openTerminal(`/seahorse-reflect Reflect on feedback cluster ${c.id} from .seahorse/reflect/input.json.`);
}

// --- onboarding ---
const ONBOARD_DIR = path.join(SEAHORSE_DIR, 'onboarding');
const PROPOSAL = path.join(ONBOARD_DIR, 'proposal.json');

function onboardingState() {
  const started = readJson(path.join(ONBOARD_DIR, 'started.json'), null);
  let proposal = null, proposalAt = null, proposalError = null;
  if (fs.existsSync(PROPOSAL)) {
    proposalAt = fs.statSync(PROPOSAL).mtime.toISOString();
    try { proposal = normalizeProposal(JSON.parse(fs.readFileSync(PROPOSAL, 'utf8'))); } catch (err) { proposalError = err.message; }
  }
  return { startedAt: started?.at ?? null, proposal, proposalAt, proposalError, prefix: workspacePrefix() };
}

const NAME_RE = /^[a-z][a-z0-9-]{1,40}$/;
const strs = (v, max = 300, n = 30) => (Array.isArray(v) ? v : []).map((s) => String(s ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max)).filter(Boolean).slice(0, n);

function normalizeProposal(raw) {
  const p = raw?.project ?? {};
  const slug = String(p.slug ?? p.name ?? path.basename(WORKSPACE)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30) || 'project';
  return {
    generated_at: raw?.generated_at ?? null,
    project: {
      name: String(p.name ?? path.basename(WORKSPACE)).slice(0, 80),
      slug,
      summary: String(p.summary ?? '').slice(0, 1000),
      stack: strs(p.stack, 80),
      modules: (Array.isArray(p.modules) ? p.modules : []).slice(0, 30).map((m) => ({ path: String(m?.path ?? '').slice(0, 200), what: String(m?.what ?? '').slice(0, 300) })).filter((m) => m.path),
      conventions: strs(p.conventions),
      constraints: (Array.isArray(p.constraints) ? p.constraints : []).slice(0, 30).map((c) => (typeof c === 'string' ? { rule: c } : { rule: String(c?.rule ?? ''), evidence: c?.evidence ? String(c.evidence) : null })).filter((c) => c.rule),
      commands: Object.fromEntries(Object.entries(p.commands ?? {}).filter(([k, v]) => /^[a-z_-]{1,20}$/i.test(k) && typeof v === 'string').map(([k, v]) => [k, v.slice(0, 200)])),
    },
    agents: (Array.isArray(raw?.agents) ? raw.agents : []).slice(0, 8).map((a) => ({
      name: String(a?.name ?? ''), role: String(a?.role ?? ''), description: String(a?.description ?? '').replace(/[\r\n`]+/g, ' ').slice(0, 200),
      purpose: String(a?.purpose ?? '').replace(/`/g, "'").slice(0, 1500), writes: strs(a?.writes, 120, 12), why: String(a?.why ?? '').slice(0, 400),
    })).filter((a) => NAME_RE.test(a.name) && ROLE_RE.test(a.role) && !CORE_ROLES.includes(a.role)),
    plugins: (Array.isArray(raw?.plugins) ? raw.plugins : []).slice(0, 8).map((x) => ({ pluginId: String(x?.pluginId ?? ''), why: String(x?.why ?? '').slice(0, 400), agents: strs(x?.agents, 60, 10) })).filter((x) => PLUGIN_RE.test(x.pluginId)),
    backlog: (Array.isArray(raw?.backlog) ? raw.backlog : []).slice(0, 12).map((b) => ({
      id: String(b?.id ?? ''), title: String(b?.title ?? '').slice(0, 200), description: String(b?.description ?? '').slice(0, 1000),
      priority: ['critical', 'high', 'medium', 'low'].includes(b?.priority) ? b.priority : 'medium', assigned_to: String(b?.assigned_to ?? ''), evidence: String(b?.evidence ?? '').slice(0, 200),
    })).filter((b) => ID_RE.test(b.id) && b.title),
  };
}

// The naming prefix the workspace already uses ("acme-" in acme-lead-agent.md), if any.
function workspacePrefix() {
  for (const a of Object.values(discoverAgents())) {
    const base = path.basename(a.file, '.md');
    for (const s of ['lead-agent', 'feature-strategist', 'reviewer-agent', 'codebase-archaeologist']) {
      if (base.endsWith(s)) return base.slice(0, base.length - s.length);
    }
  }
  return null;
}

async function startOnboarding() {
  let market = { installed: [], available: [] };
  try { market = await catalog(); } catch {}
  fs.mkdirSync(ONBOARD_DIR, { recursive: true });
  if (fs.existsSync(PROPOSAL)) fs.renameSync(PROPOSAL, path.join(ONBOARD_DIR, 'proposal.previous.json'));
  writeJsonAtomic(path.join(ONBOARD_DIR, 'catalog.json'), market.available.map((p) => ({ pluginId: p.pluginId, description: p.description, category: p.category ?? null, installCount: p.installCount ?? null })));
  const exists = (p) => fs.existsSync(path.join(WORKSPACE, p));
  writeJsonAtomic(path.join(ONBOARD_DIR, 'existing.json'), {
    agents: Object.values(discoverAgents()).map((a) => ({ role: a.role, file: a.file, description: a.description })),
    files: Object.fromEntries(['orchestrator.json', 'backlog.json', 'orchestrator/memory/core.md', 'orchestrator/memory/domain_context.md', 'CLAUDE.md'].map((p) => [p, exists(p)])),
    installed_plugins: market.installed.map((p) => p.pluginId ?? p.id ?? p.name),
  });
  writeJsonAtomic(path.join(ONBOARD_DIR, 'started.json'), { at: new Date().toISOString() });
  installKitCommand('seahorse-onboard');
  ensureWatchers();
  notify();
  return openTerminal('/seahorse-onboard Study this repository and write the Seahorse proposal.');
}

// Creates everything the reviewed proposal asks for. Never overwrites an existing file.
async function applyOnboarding(body) {
  const { proposal } = onboardingState();
  if (!proposal) throw new Error('Run discovery first: there is no proposal yet');
  const prefix = String(body?.prefix ?? '');
  if (!/^([a-z0-9][a-z0-9-]{0,30}-)?$/.test(prefix)) throw new Error('The prefix must be lowercase letters, digits and dashes, ending in a dash (like acme-)');
  const existing = discoverAgents();
  const chosen = (Array.isArray(body?.agents) ? body.agents : []).map((c) => {
    const a = proposal.agents.find((x) => x.role === c?.role);
    if (!a) throw new Error(`${c?.role} is not in the proposal`);
    const writes = strs(c.writes, 120, 12);
    if (!writes.length) throw new Error(`Give ${a.role} at least one path it may write`);
    return { ...a, writes };
  });
  const project = proposal.project.name;
  const report = [];
  const put = (rel, content) => {
    const file = path.join(WORKSPACE, rel);
    if (fs.existsSync(file)) { report.push({ path: rel, status: 'kept' }); return; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, { flag: 'wx' });
    report.push({ path: rel, status: 'created' });
  };
  const now = new Date().toISOString();

  // Agents
  const workerRoles = [...new Set([...chosen.map((a) => a.role), ...Object.keys(existing).filter((r) => !CORE_ROLES.includes(r))])];
  for (const role of CORE_ROLES) {
    if (existing[role]) { report.push({ path: existing[role].file, status: 'kept' }); continue; }
    const f = coreAgentFile(role, { prefix, project, workers: workerRoles });
    put(path.join('.claude', 'commands', f.name), f.text);
  }
  for (const a of chosen) {
    if (existing[a.role]) { report.push({ path: existing[a.role].file, status: 'kept' }); continue; }
    const f = workerAgentFile({ prefix, ...a });
    put(path.join('.claude', 'commands', f.name), f.text);
  }

  // Orchestrator memory and state
  const agentsNow = discoverAgents();
  put('orchestrator.json', JSON.stringify({
    version: 'v1', updated_at: now, active_project: null, projects: {},
    rules: { project_creation_owner: 'lead_agent', spec_owner: 'lead_agent', status_owner: 'lead_agent', worker_message_owner: 'self_only', lesson_promotion_owner: 'lead_agent', research_owner: 'reviewer_agent', documentation_owner: 'codebase_archaeologist' },
  }, null, 2) + '\n');
  const items = body?.backlog ? proposal.backlog.map((b) => ({
    id: b.id, title: b.title, description: b.evidence ? `${b.description} (evidence: ${b.evidence})` : b.description,
    priority: b.priority, status: 'pending', assigned_to: agentsNow[b.assigned_to] ? b.assigned_to : 'lead_agent', labels: ['onboarding'],
  })) : [];
  put('backlog.json', JSON.stringify({ version: 'v1', updated_at: now, items }, null, 2) + '\n');
  put('orchestrator/memory/core.md', buildCoreMd({ project, agents: agentsNow, workers: chosen, constraints: proposal.project.constraints }));
  put('orchestrator/memory/domain_context.md', buildDomainContextMd({ project, proposal, workers: chosen, matches: globMatches }));
  put('orchestrator/memory/patterns.json', JSON.stringify({ patterns: proposal.project.conventions.map((c, i) => ({ id: `P${String(i + 1).padStart(3, '0')}`, rule: c, source: 'onboarding' })) }, null, 2) + '\n');
  put('orchestrator/memory/lessons.json', JSON.stringify({ lessons: [] }, null, 2) + '\n');
  for (const dir of ['schemas', 'templates']) {
    for (const f of fs.readdirSync(path.join(KIT, 'orchestrator', dir))) put(`orchestrator/${dir}/${f}`, fs.readFileSync(path.join(KIT, 'orchestrator', dir, f), 'utf8'));
  }
  put('orchestrator/research/.gitkeep', '');
  // projects/ stays empty: the lead creates each project folder itself.
  fs.mkdirSync(path.join(ORCH, 'projects'), { recursive: true });

  ensureWatchers();
  notify();
  return { report, workspaceConfigured: isConfigured() };
}

// --- plugin marketplace (through the claude CLI) ---
const CLAUDE_BIN = (() => {
  try { return execFileSync('/bin/sh', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim() || 'claude'; } catch { return 'claude'; }
})();

function runClaude(args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(CLAUDE_BIN, args, { cwd: WORKSPACE, timeout, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr), error: err?.message });
    });
  });
}

// Categories live in each marketplace's own marketplace.json, not in the CLI output.
function marketplaceCategories() {
  const known = readJson(path.join(os.homedir(), '.claude', 'plugins', 'known_marketplaces.json'), {});
  const categories = {};
  for (const [market, info] of Object.entries(known ?? {})) {
    const manifest = readJson(path.join(info.installLocation ?? '', '.claude-plugin', 'marketplace.json'), {});
    for (const p of manifest?.plugins ?? []) categories[`${p.name}@${market}`] = { category: p.category ?? null, homepage: p.homepage ?? null, author: p.author?.name ?? null };
  }
  return categories;
}

let catalogCache = null;
async function catalog(force = false) {
  if (!force && catalogCache && Date.now() - catalogCache.at < 5 * 60 * 1000) return catalogCache.data;
  const out = await runClaude(['plugin', 'list', '--json', '--available']);
  if (!out.ok) throw new Error(`claude plugin list failed: ${out.stderr || out.error}`);
  const parsed = JSON.parse(out.stdout);
  const extra = marketplaceCategories();
  const data = {
    installed: parsed.installed ?? [],
    available: (parsed.available ?? []).map((p) => ({ ...p, ...(extra[p.pluginId] ?? {}) })),
  };
  catalogCache = { at: Date.now(), data };
  return data;
}

const PLUGIN_RE = /^[a-z0-9][a-z0-9._-]{0,100}@[a-z0-9][a-z0-9._-]{0,100}$/i;
const installedIds = (data) => new Set(data.installed.map((p) => p.pluginId ?? p.id ?? p.name).filter(Boolean));

async function pluginAction({ action, pluginId }) {
  if (!['install', 'uninstall'].includes(action)) throw new Error('Unknown plugin action');
  if (!PLUGIN_RE.test(String(pluginId))) throw new Error('Invalid plugin id');
  const data = await catalog();
  const known = data.available.some((p) => p.pluginId === pluginId) || installedIds(data).has(pluginId);
  if (!known) throw new Error(`${pluginId} is not in any known marketplace`);
  const args = action === 'install'
    ? ['plugin', 'install', pluginId, '--scope', 'project']
    : ['plugin', 'uninstall', pluginId, '--scope', 'project'];
  const out = await runClaude(args, 5 * 60 * 1000);
  const fresh = await catalog(true);
  if (action === 'uninstall' && out.ok) {
    const skills = readConfig('skills.json');
    for (const role of Object.keys(skills)) skills[role] = skills[role].filter((id) => id !== pluginId);
    writeJsonAtomic(path.join(SEAHORSE_DIR, 'skills.json'), Object.fromEntries(Object.entries(skills).filter(([, v]) => v.length)));
  }
  notify();
  return { ok: out.ok, output: (out.stdout + out.stderr).trim().slice(-2000) || out.error, installed: fresh.installed };
}

// --- agent launching ---
// Prompts are fixed text plus validated ids: nothing from the browser reaches the shell verbatim.
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/i;
const ROLE_RE = /^[a-z][a-z0-9_]{1,40}$/;

function buildPrompt({ agent, kind, id, project, action, from }, state) {
  if (kind === 'agent') return '';
  if (kind === 'item') {
    if (!(state.backlog.items ?? []).some((i) => i.id === id)) throw new Error(`Backlog item ${id} not found`);
    if (agent === 'lead_agent') {
      return `Pick up backlog item ${id} from backlog.json. Decide whether it needs the feature strategist or can go through the hotfix protocol, create the project and tasks if appropriate, and tell me which agent to start next.`;
    }
    if (agent === 'feature_strategist') return `Scope backlog item ${id} from backlog.json and produce your handoff block for it.`;
    throw new Error('Backlog items go to the lead agent or the feature strategist. Workers need a task file first.');
  }
  if (kind === 'task') {
    if (project !== state.orchestrator.active_project) throw new Error(`${project} is not the active project`);
    const task = state.projects.find((p) => p.id === project)?.tasks.find((t) => t.task_id === id);
    if (!task) throw new Error(`Task ${id} not found in ${project}`);
    if (task.assigned_to !== agent) throw new Error(`${id} is assigned to ${task.assigned_to}`);
    return `Work on ${id} in the active project ${project}.`;
  }
  if (kind === 'handoff') {
    // The protocol's relay step: a worker reported done, so the lead reads its message file.
    if (agent !== 'lead_agent') throw new Error('Finished work is always reported to the lead agent.');
    if (!ROLE_RE.test(String(from))) throw new Error('Invalid agent');
    const p = state.projects.find((x) => x.id === project);
    if (!p) throw new Error(`Project ${project} not found`);
    if (!p.messages[from]) throw new Error(`${from} has no message file in ${project}`);
    return `${from} finished work on project ${project}. Read orchestrator/projects/${project}/messages/${from}.json, update the task and status files, promote any lessons, and tell me which agent to start next.`;
  }
  if (kind === 'lesson') {
    const lesson = lessonList().find((l) => l.id === id);
    if (!lesson) throw new Error(`Lesson ${id} not found`);
    if (agent !== 'lead_agent') throw new Error('Lessons are enforced and retired by the lead agent, which owns lessons.json.');
    if (action === 'enforce') {
      return `Enforce lesson ${id} from orchestrator/memory/lessons.json. Read the code (read-only, as in your cross-repo triage rules) and find every place that still makes this mistake, with file and line. If you find any, log them in backlog.json (or link the existing item) and create a fix task through the hotfix protocol. Do not write application code. If the code is clean, say so.`;
    }
    if (action === 'retire') {
      if (lesson.status === 'retired') throw new Error(`${id} is already retired`);
      return `Retire lesson ${id} in orchestrator/memory/lessons.json. First check the current code to confirm the mistake it describes can no longer happen. If so, keep the entry but add "status": "retired", "retired_at" (ISO 8601) and "retired_reason" (one line). If the mistake is still possible, do not retire it; tell me why instead.`;
    }
    throw new Error('Unknown lesson action');
  }
  if (kind === 'proposal') {
    // Accepting a lesson proposal: the lead files it, since it owns lessons.json.
    const proposal = readProposals().find((p) => p.id === id);
    if (!proposal) throw new Error(`Proposal ${id} not found`);
    if (proposal.kind !== 'lesson') throw new Error('Only lesson proposals go to the lead');
    if (agent !== 'lead_agent') throw new Error('Lessons are filed by the lead agent, which owns lessons.json.');
    return `Add the lesson from proposal ${id} in .seahorse/proposals.json to orchestrator/memory/lessons.json with the next free L id. Its evidence ids point to user feedback the user gave more than once. Then tell me the new lesson id.`;
  }
  throw new Error('Unknown launch kind');
}

// Pinned lessons and assigned plugins, appended to every launch of that agent.
function extrasFor(agent) {
  const live = new Set(lessonList().filter((l) => l.status !== 'retired').map((l) => l.id));
  const lessons = (readConfig('reminders.json')[agent] ?? []).filter((id) => live.has(id));
  const plugins = (readConfig('skills.json')[agent] ?? []).map((id) => id.split('@')[0]);
  let text = '';
  if (lessons.length) text += ` Before you start, re-read lesson${lessons.length > 1 ? 's' : ''} ${lessons.join(', ')} in orchestrator/memory/lessons.json and apply ${lessons.length > 1 ? 'them' : 'it'} to this work.`;
  if (plugins.length) text += ` Where they help with this work, use the skills from these installed plugins: ${plugins.join(', ')}.`;
  return text;
}

const shQuote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appleQuote = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function launch(body) {
  const { agent, kind, id, project } = body ?? {};
  const state = loadState();
  if (!state.agents[agent]) throw new Error(`No agent with role ${agent}`);
  if (kind !== 'agent' && kind !== 'handoff' && !ID_RE.test(String(id))) throw new Error('Invalid id');
  if ((kind === 'task' || kind === 'handoff') && !ID_RE.test(String(project))) throw new Error('Invalid project');
  const prompt = `${state.agents[agent]} ${buildPrompt(body, state)}${extrasFor(agent)}`.replace(/\s+$/, '').replace(/^(\S+)\s{2,}/, '$1 ');
  return openTerminal(prompt);
}

// Opens `claude '<prompt>'` in a new Terminal window, or returns the command to copy.
function openTerminal(prompt) {
  const command = `cd ${shQuote(WORKSPACE)} && ${shQuote(CLAUDE_BIN)} ${shQuote(prompt)}`;
  if (process.platform !== 'darwin' || process.env.BOARD_NO_TERMINAL) return Promise.resolve({ launched: false, command });
  const script = `tell application "Terminal"\nactivate\ndo script ${appleQuote(command)}\nend tell`;
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], (err) => resolve(err ? { launched: false, command, error: err.message } : { launched: true, command }));
  });
}

// --- creating agents ---
const oneLine = (s, max) => String(s ?? '').replace(/[\r\n`]+/g, ' ').trim().slice(0, max);

function createAgent(body) {
  const name = String(body?.name ?? '');
  const role = String(body?.role ?? '');
  if (!/^[a-z][a-z0-9-]{1,40}$/.test(name)) throw new Error('Name must be lowercase letters, digits and dashes, like docs-writer');
  if (!ROLE_RE.test(role)) throw new Error('Role id must be lowercase letters, digits and underscores, like docs_agent');
  const agents = discoverAgents();
  if (agents[role]) throw new Error(`An agent with role ${role} already exists`);
  const description = oneLine(body.description, 200);
  const purpose = String(body.purpose ?? '').replace(/`/g, "'").trim().slice(0, 1500);
  const writes = (Array.isArray(body.writes) ? body.writes : []).map((w) => oneLine(w, 120)).filter(Boolean).slice(0, 12);
  if (!description) throw new Error('Add a one-line description');
  if (!purpose) throw new Error('Describe what the agent does');
  if (!writes.length) throw new Error('List at least one path the agent may write');

  // Reuse the workspace's naming prefix.
  const prefix = workspacePrefix() ?? '';
  const { name: fileName, text } = workerAgentFile({ prefix, name, role, description, purpose, writes });
  const file = path.join(COMMANDS, fileName);
  if (fs.existsSync(file)) throw new Error(`${path.relative(WORKSPACE, file)} already exists`);
  fs.mkdirSync(COMMANDS, { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx' });
  notify();
  return { file: path.relative(WORKSPACE, file), command: `/${prefix}${name}`, role, writes };
}

// --- request guards ---
// Any website can POST to localhost, so writes require the per-run token
// embedded in the page and a Host header that is actually localhost.
const TOKEN = crypto.randomBytes(24).toString('hex');
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 16384) { reject(new Error('Body too large')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('Invalid JSON')); } });
  });
}

// --- live updates (Server-Sent Events) ---
const clients = new Set();
let debounce;
function notify() {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    for (const res of clients) res.write('data: change\n\n');
  }, 200);
}

// Watch directories, not files: editors and agents often replace files atomically.
// Folders that don't exist yet (a fresh workspace) get watched once they appear.
const watching = new Set();
function watchOnce(dir, opts, filter = () => true) {
  if (watching.has(dir) || !fs.existsSync(dir)) return;
  try {
    fs.watch(dir, opts, (_event, name) => { if (filter(name)) notify(); });
    watching.add(dir);
  } catch {}
}
function ensureWatchers() {
  watchOnce(ORCH, { recursive: true }, (name) => name && !name.startsWith('.git'));
  watchOnce(COMMANDS, {});
  watchOnce(SEAHORSE_DIR, { recursive: true }, (name) => name && !name.endsWith('.tmp'));
}
fs.watch(WORKSPACE, (_event, name) => {
  if (name === 'orchestrator.json' || name === 'backlog.json') notify();
  if (name === 'orchestrator' || name === '.seahorse' || name === '.claude') { ensureWatchers(); notify(); }
});
ensureWatchers();

// --- http ---
const INDEX = path.join(HERE, 'public', 'index.html');

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}
const sendJson = (res, status, data) => send(res, status, 'application/json', JSON.stringify(data));

const POST_ROUTES = {
  '/api/launch': async (body) => {
    const result = await launch(body);
    console.log(`${result.launched ? 'Launched' : 'Prepared'}: ${result.command}`);
    return result;
  },
  '/api/reminders': (body) => {
    if (!lessonList().some((l) => l.id === body?.lesson)) throw new Error(`Lesson ${body?.lesson} not found`);
    if (!discoverAgents()[body?.agent]) throw new Error(`Unknown agent ${body?.agent}`);
    return { reminders: toggleInConfig('reminders.json', body.agent, body.lesson, body.on) };
  },
  '/api/skills': (body) => {
    if (!discoverAgents()[body?.agent]) throw new Error(`Unknown agent ${body?.agent}`);
    if (!PLUGIN_RE.test(String(body?.pluginId))) throw new Error('Invalid plugin id');
    return { skills: toggleInConfig('skills.json', body.agent, body.pluginId, body.on) };
  },
  '/api/plugins': (body) => pluginAction(body ?? {}),
  '/api/agents': (body) => createAgent(body),
  '/api/feedback': (body) => logFeedback(body ?? {}),
  '/api/feedback/setup': () => setupFeedback(),
  '/api/reflect': (body) => startReflect(body ?? {}),
  '/api/proposals': (body) => setProposalStatus(body ?? {}),
  '/api/onboarding/start': () => startOnboarding(),
  '/api/onboarding/apply': (body) => applyOnboarding(body),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === 'POST' && POST_ROUTES[url.pathname]) {
    if (!ALLOWED_HOSTS.has(req.headers.host) || req.headers['x-board-token'] !== TOKEN || !String(req.headers['content-type']).startsWith('application/json')) {
      return sendJson(res, 403, { error: 'Forbidden' });
    }
    try {
      return sendJson(res, 200, await POST_ROUTES[url.pathname](await readBody(req)));
    } catch (err) {
      return sendJson(res, 400, { error: err.message });
    }
  }

  if (req.method !== 'GET') return send(res, 405, 'text/plain', 'Method not allowed');

  if (url.pathname === '/') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(INDEX, 'utf8').replace('__BOARD_TOKEN__', TOKEN));
  }
  if (url.pathname === '/api/state') return sendJson(res, 200, loadState());
  if (url.pathname === '/api/marketplace') {
    try { return sendJson(res, 200, await catalog(url.searchParams.has('refresh'))); }
    catch (err) { return sendJson(res, 502, { error: err.message }); }
  }

  const review = url.pathname.match(/^\/api\/review\/([a-z0-9][a-z0-9-]*)$/i);
  if (review) {
    const file = path.join(ORCH, 'research', `review-${review[1]}.md`);
    if (!fs.existsSync(file)) return send(res, 404, 'text/plain', 'No review report');
    return send(res, 200, 'text/plain; charset=utf-8', fs.readFileSync(file));
  }

  if (url.pathname === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  send(res, 404, 'text/plain', 'Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Seahorse → http://localhost:${PORT}`);
  console.log(`Watching ${WORKSPACE}`);
  console.log(`Agents: ${Object.values(discoverAgents()).map((a) => a.command).join(', ') || 'none found in .claude/commands'}`);
});
