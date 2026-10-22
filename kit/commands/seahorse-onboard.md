---
description: Seahorse onboarding. Studies this repository and proposes agents, write permissions, tools and starting backlog. Writes only its proposal file.
---

# SEAHORSE ONBOARDING
You are onboarding this repository into a Seahorse agent orchestrator: a team of Claude agents (a lead, a strategist, workers, a reviewer, a docs archaeologist) that coordinate through JSON files. Your job is to study the codebase and propose that team. A person reviews your proposal in Seahorse before anything is created.

You write exactly ONE file: `.seahorse/onboarding/proposal.json`. You do not write, move or delete anything else.

# READ FIRST
1. `.seahorse/onboarding/existing.json`: agents and orchestrator files that already exist. Don't propose duplicates.
2. `.seahorse/onboarding/catalog.json`: the ONLY plugins you may propose, with descriptions.
3. README, manifests (package.json, pyproject.toml, go.mod, Cargo.toml, Gemfile, pom.xml…), lockfiles, CI config, Dockerfiles, existing CLAUDE.md / AGENTS.md / docs.
4. The top-level folders, then sample real source files in each main module to learn the conventions actually used.

# DECIDE
1. **Project:** name, a kebab-case slug, a two-sentence summary, the stack, the main modules (path and what lives there), the conventions you observed (naming, imports, error handling, testing style), the commands to install / test / lint / build, and the constraints: invariants that must never break (security, data, tenancy, compatibility). Only list a constraint if you found evidence; cite the file.
2. **Worker agents:** one per area of code that changes independently (for example backend, frontend, mobile, infra, data). Seahorse adds the lead, strategist, reviewer and archaeologist itself; do NOT propose those. Fewer is better: usually 1 to 4. Their write paths must not overlap.
3. **Plugins:** up to 6 from `catalog.json` that clearly fit this stack or this team's gaps. Say why, and which roles should use each (your workers, or `lead_agent`, `feature_strategist`, `reviewer_agent`, `codebase_archaeologist`). Copy `pluginId` exactly.
4. **Backlog (optional):** up to 8 concrete issues you found (TODO/FIXME, missing tests, risky code), each with file evidence.

# OUTPUT
Write valid JSON in exactly this shape:
```json
{
  "version": 1,
  "generated_at": "<ISO8601>",
  "project": {
    "name": "Acme Billing",
    "slug": "acme-billing",
    "summary": "Two sentences on what this is and who uses it.",
    "stack": ["Node 20", "Express", "Postgres", "React 18"],
    "modules": [{ "path": "server/", "what": "REST API and jobs" }],
    "conventions": ["ESM imports with .js extensions (server/src/app.js)"],
    "constraints": [{ "rule": "Every query is scoped by accountId", "evidence": "server/src/db/scope.js" }],
    "commands": { "install": "npm ci", "test": "npm test", "lint": "npm run lint", "build": "npm run build" }
  },
  "agents": [
    {
      "name": "backend-agent",
      "role": "backend_agent",
      "description": "One line: what it builds and where.",
      "purpose": "A short paragraph written to the agent, starting with 'You are the Backend Agent…'.",
      "writes": ["server/**"],
      "why": "Why this area deserves its own agent."
    }
  ],
  "plugins": [{ "pluginId": "name@marketplace", "why": "…", "agents": ["backend_agent"] }],
  "backlog": [{ "id": "bug-001", "title": "…", "description": "…", "priority": "high", "assigned_to": "backend_agent", "evidence": "server/src/x.js:42" }]
}
```

# RULES
- Evidence over guesses. If you aren't sure, leave it out.
- Never invent plugins, paths or commands.
- Role ids are snake_case and end in `_agent`; names are kebab-case and end in `-agent`.
- When the file is written, tell the user: "Proposal ready. Review it in Seahorse."
