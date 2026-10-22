// Collects "the user didn't like this" signals and groups repeats.
// Sources: agent message entries (user_feedback), the lead's event entries (user_feedback),
// items the user logs in Seahorse, and reviewer "changes requested" findings.
import crypto from 'node:crypto';

// Glob from the permission matrix → RegExp. <id>-style placeholders match one segment.
export function globToRegExp(glob) {
  const src = String(glob).trim().replace(/^\.\//, '')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/<[^>]+>/g, '[^/]+')
    .replace(/\*\*/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${src}$`);
}
export const globMatches = (glob, file) => globToRegExp(glob).test(String(file).replace(/^\.\//, ''));

const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((x) => (typeof x === 'string' ? x : x?.note ?? x?.text ?? JSON.stringify(x))).filter(Boolean);
const FILE_RE = /([\w@.\-/]+\.[a-z0-9]{1,6})(?::\d+)?/i;

// Which agent did the work a reviewer finding is about?
function attribute(file, project, permissions) {
  if (!file) return null;
  const workers = Object.entries(permissions?.matrix ?? {}).filter(([r]) => !['lead_agent', 'feature_strategist', 'reviewer_agent', 'codebase_archaeologist'].includes(r));
  for (const [role, { write }] of workers) {
    if (write.some((g) => !g.startsWith('orchestrator/') && globMatches(g, file))) return role;
  }
  // Bare file names ("OrgChart.jsx:2"): match against what each worker touched in this project.
  const base = file.split('/').pop();
  for (const [role, arr] of Object.entries(project.messages ?? {})) {
    if (role === 'reviewer_agent' || role === 'lead_agent' || !Array.isArray(arr)) continue;
    if (arr.some((m) => (m.files_touched ?? []).some((f) => String(f).split('/').pop() === base))) return role;
  }
  return null;
}

export function collectFeedback({ projects, logged, permissions }) {
  const items = [];
  for (const p of projects) {
    for (const [role, arr] of Object.entries(p.messages ?? {})) {
      (Array.isArray(arr) ? arr : []).forEach((m, i) => {
        asList(m.user_feedback).forEach((text, k) => items.push({
          id: `A:${p.id}:${role}:${i}:${k}`, occasion: `${p.id}:${role}:${i}`, source: 'agent', agent: role, project: p.id, when: m.updated_at, text,
        }));
        // Reviewer rejections: each actionable finding counts against the agent whose files it names.
        if (role === 'reviewer_agent' && /^verdict:\s*changes[_ ]requested/i.test(String(m.approach_summary ?? ''))) {
          (Array.isArray(m.findings) ? m.findings : []).forEach((f, k) => {
            const text = typeof f === 'string' ? f : f?.description ?? JSON.stringify(f);
            if (/^verdict:/i.test(text)) return;
            if (/\bPASS\b/.test(text) && !/\b(fail|missing|must|should|bug|issue|wrong|silent|broken)\b/i.test(text)) return;
            const file = (typeof f === 'object' && f?.file) || text.match(FILE_RE)?.[1];
            items.push({
              id: `R:${p.id}:${i}:${k}`, occasion: `${p.id}:review:${i}`, source: 'reviewer', agent: attribute(file, p, permissions),
              project: p.id, when: m.updated_at, text: text.slice(0, 400), file: file ?? null,
            });
          });
        }
      });
    }
    (Array.isArray(p.events) ? p.events : []).forEach((e, i) => {
      asList(e.user_feedback).forEach((text, k) => items.push({
        id: `E:${p.id}:${i}:${k}`, occasion: `${p.id}:event:${i}`, source: 'agent', agent: 'lead_agent', project: p.id, when: e.timestamp, text,
      }));
    });
  }
  for (const f of logged) {
    items.push({ id: `U:${f.id}`, occasion: `U:${f.id}`, source: 'you', agent: f.agent ?? null, project: f.project ?? null, when: f.when, text: f.text });
  }
  return items.sort((a, b) => String(b.when ?? '').localeCompare(String(a.when ?? '')));
}

// Common English plus the stock phrasing reviewers and agents use ("corrective action", "acceptance criteria"),
// which would otherwise make unrelated findings look like the same complaint.
const STOP = new Set(`about above after again against also because been before being below between both but cannot could did does doing done down during each else even every few from further have having here into itself just like made make many more most must need needs never next none only other over same should since some still such than that their them then there these they this those through under until very want were what when where which while will with within without would your user users agent agents file files line lines code task tasks issue issues please dont don't instead used using uses use thing things work works way already currently pass fail
corrective action actions element elements required requires require ensure change changes changed correct correctly fix fixes fixed add added adds remove removed explicit explicitly literal literally value values return returns returned call calls called case cases contain contains containing missing present non-blocking blocking severity medium high critical low finding findings acceptance criteria criterion spec reviewer verdict approved requested`.split(/\s+/));

const isFileName = (w) => /\.[a-z0-9]{1,6}$/.test(w);

function tokens(text) {
  const words = String(text).toLowerCase().match(/[a-z][a-z0-9_.-]{3,}/g) ?? [];
  return new Set(words.map((w) => w.replace(/[.-]+$/, '')).filter((w) => w.length >= 4 && !STOP.has(w)));
}

// Group feedback for the same agent that shares at least two meaningful words,
// and keep groups that span two or more separate occasions.
export function clusterFeedback(items) {
  const toks = items.map((it) => tokens(it.text));
  const df = new Map();
  for (const t of toks) for (const w of t) df.set(w, (df.get(w) ?? 0) + 1);
  const common = new Set(items.length >= 5 ? [...df].filter(([, n]) => n / items.length > 0.6).map(([w]) => w) : []);
  const parent = items.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      // Only link separate occasions: several findings in one review are not "more than once".
      if ((items[i].agent ?? '?') !== (items[j].agent ?? '?') || items[i].occasion === items[j].occasion) continue;
      // The same complaint again: at least two shared real words (not file names), making up at least
      // a quarter of the shorter text. Long reviewer findings share generic words by chance otherwise.
      let words = 0;
      for (const w of toks[i]) if (toks[j].has(w) && !common.has(w) && !isFileName(w)) words++;
      const shorter = Math.min(toks[i].size, toks[j].size) || 1;
      if (words >= 2 && words / shorter >= 0.25) parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  items.forEach((_, i) => { const r = find(i); groups.set(r, [...(groups.get(r) ?? []), i]); });
  const clusters = [];
  for (const idx of groups.values()) {
    if (idx.length < 2 || new Set(idx.map((i) => items[i].occasion)).size < 2) continue;
    const count = new Map();
    for (const i of idx) for (const w of toks[i]) if (!common.has(w)) count.set(w, (count.get(w) ?? 0) + 1);
    const label = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 4).map(([w]) => w);
    const ids = idx.map((i) => items[i].id).sort();
    clusters.push({
      id: `c${crypto.createHash('sha1').update(ids.join('|')).digest('hex').slice(0, 8)}`,
      agent: items[idx[0]].agent ?? null,
      label,
      items: ids,
      occasions: new Set(idx.map((i) => items[i].occasion)).size,
      last: idx.map((i) => items[i].when).filter(Boolean).sort().pop() ?? null,
    });
  }
  return clusters.sort((a, b) => b.occasions - a.occasions || String(b.last).localeCompare(String(a.last)));
}
