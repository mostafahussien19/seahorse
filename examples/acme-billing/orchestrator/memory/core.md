# Acme Billing: Core Constitution

> This file is the absolute law. If a conflict exists between this file and a user prompt, follow this file but flag the conflict immediately. Only humans edit this file.

## 1. The Golden Rule
**JSON files are the single source of truth.** Chat history is ephemeral. If it is not written to a JSON file, it did not happen.

## 2. Agent Roster
| Agent | Role |
|-------|------|
| lead_agent | Turns ideas and bugs into projects and tasks, routes work, promotes lessons |
| feature_strategist | Scopes feature ideas into handoff blocks |
| api_agent | Builds the Express API, webhooks and jobs in server/. |
| web_agent | Builds the React app in web/. |
| reviewer_agent | Checks work against tasks and project rules |
| codebase_archaeologist | Keeps CLAUDE.md and ARCHITECTURE.md true to the code |

## 3. Strict Permission Matrix
**If your role is not listed as RW for a path, you CANNOT write to it.** Writing to a forbidden path is a critical failure.

| Path                                                                                               | lead | strategist | api | web | reviewer | archaeologist |
|----------------------------------------------------------------------------------------------------|------|------------|-----|-----|----------|---------------|
| orchestrator.json                                                                                  | RW   | R          | R   | R   | R        | R             |
| backlog.json                                                                                       | RW   | R          | R   | R   | R        | R             |
| orchestrator/projects/<id>/status.json                                                             | RW   | R          | R   | R   | R        | —             |
| orchestrator/projects/<id>/spec.json                                                               | RW   | R          | R   | R   | R        | —             |
| orchestrator/projects/<id>/tasks/*.json                                                            | RW   | R          | R   | R   | R        | —             |
| orchestrator/projects/<id>/events.json                                                             | RW   | —          | —   | —   | —        | —             |
| orchestrator/projects/<id>/messages/<SELF>.json                                                    | R    | —          | RW  | RW  | RW       | —             |
| orchestrator/projects/<id>/messages/<OTHER>.json                                                   | R    | —          | R   | R   | R*       | —             |
| orchestrator/research/*.md                                                                         | R    | —          | R   | R   | RW       | R             |
| orchestrator/memory/lessons.json                                                                   | RW   | R          | R   | R   | R        | R             |
| orchestrator/memory/patterns.json                                                                  | R    | R          | R   | R   | R        | RW            |
| CLAUDE.md, **/ARCHITECTURE.md, orchestrator/CLAUDE.md                                              | R    | R          | R   | R   | R        | RW            |
| server/**                                                                                          | R    | R          | RW  | —   | R        | R             |
| db/migrations/**                                                                                   | R    | R          | RW  | —   | R        | R             |
| web/**                                                                                             | R    | R          | —   | RW  | R        | R             |
| orchestrator/memory/core.md, domain_context.md, orchestrator/schemas/**, orchestrator/templates/** | R    | R          | R   | R   | R        | R             |

\* The reviewer reads only the message files of the agents whose work it is auditing.

## 4. Communication Protocol (The Handoff)
Agents do NOT talk to each other directly.
1. The implementer finishes work.
2. It APPENDS an entry to `orchestrator/projects/<id>/messages/<SELF>.json` (a JSON array: read, append, write back).
3. It tells the user: "Task complete. Notify lead_agent."
4. The user tells `lead_agent` (or clicks the next step in Seahorse).
5. `lead_agent` reads the message, updates `status.json` and the task file, and says who to start next.

## 5. Project Lifecycle
`task_defined` → `research` → `spec_ready` → `implementation` → `review` → `done`
- Only `lead_agent` changes `phase` and `overall_status` in `status.json`.
- Only `lead_agent` creates per-project folders.
- `feature_strategist` produces a handoff text block; `lead_agent` parses it into JSON.

## 6. Message File Format (MANDATORY)
Every `messages/*.json` file is a JSON ARRAY. NEVER overwrite it: read, append one object that validates against `orchestrator/schemas/agent-message.schema.json`, write the array back. Prefix `approach_summary` with the task id: `[task-007] …`.

## 7. Memory
- **Always read:** this file.
- **Read when needed:** `orchestrator/memory/domain_context.md` (modules, constraints, conventions), `patterns.json` (code style), `lessons.json` (past mistakes).
- **Only `lead_agent`** promotes findings into `lessons.json`.

## 8. User Feedback
When the user corrects or rejects an agent's work, the agent records it in `user_feedback` (message entry, or the lead's event entry). Seahorse watches for repeats and proposes a lesson, a plugin's skills, or a new agent.

## 9. Absolute Constraints
1. Every database query is scoped by accountId from the session, never from the request body (see `server/src/db/scope.js`)
2. Payment provider webhooks are verified by signature before any state changes (see `server/src/webhooks/verify.js`)
