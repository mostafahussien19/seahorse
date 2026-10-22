# Seahorse

**A live board and memory for a team of Claude Code agents.**

*Hippocampus* is Greek for seahorse: the part of the brain that turns short-lived experience into lasting memory. Seahorse does that for AI agents. Chat is forgotten; what the agents write to JSON files is remembered, shown, and used to make the next run better.

Seahorse sets up a small team of Claude Code agents for your repository (a lead, a strategist, one worker per area of your code, a reviewer and a docs keeper), each with exact write permissions. It then gives you one page to run that team from: a backlog you can drag onto agents, a workflow view that tells you who to start next, lessons learned, plugins, and a memory of what you keep correcting.

No dependencies. One `node` process, one HTML page, files in your repo.

## Requirements

- **Node 20 or newer**
- **[Claude Code](https://docs.claude.com/en/docs/claude-code)** with the `claude` command on your `PATH`
- **macOS** for one-click agent launches (Seahorse opens a Terminal window running `claude`). On Linux and Windows everything works, but launching shows the command to copy instead.

## Quick start

Run it from the repository you want to work on:

```bash
cd ~/code/your-app
npx github:OWNER/seahorse
```

Open **http://localhost:4600**. A repository without an agent team opens on **Setup**:

1. **Discover.** Seahorse opens `/seahorse-onboard`, a read-only Claude agent that studies your repo: stack, modules, conventions, commands, the rules that must never break, and issues it can point to in the code. It writes one proposal file.
2. **Review** the proposed worker agents and exactly which paths each may write. Untick or edit anything.
3. **Pick tools** from your Claude Code plugin marketplaces. Seahorse only offers plugins that exist there.
4. **Create.** Seahorse writes the agent files and the orchestrator memory, then installs the plugins you kept.

Then start the Lead from the Backlog page and go.

### Other ways to run it

```bash
git clone https://github.com/OWNER/seahorse.git
node seahorse/server.mjs ~/code/your-app     # any repo path

PORT=5000 npx github:OWNER/seahorse          # another port
BOARD_NO_TERMINAL=1 npx github:OWNER/seahorse   # show commands instead of opening Terminal
```

## How the team works

Seahorse follows one rule: **if it isn't in a JSON file, it didn't happen.** Agents never talk to each other. Each one appends to its own message file, and the lead reads those files and decides what happens next.

| Agent | Job | Writes |
|---|---|---|
| Lead | Turns ideas and bugs into projects and tasks, routes work, promotes lessons | `orchestrator.json`, `backlog.json`, project status, tasks, `lessons.json` |
| Strategist | Scopes a feature idea into a handoff block | Nothing |
| Workers (one per area, e.g. `api_agent`, `web_agent`) | Build the task they were given | Their own code paths and their message file |
| Reviewer | Checks the work against the task and the project's rules | Review reports and its message file |
| Archaeologist | Keeps `CLAUDE.md` and `ARCHITECTURE.md` files true to the code | Docs and `patterns.json` |

Who may write what is a **permission matrix** in `orchestrator/memory/core.md`. Only you edit that file.

A project moves through `task_defined → research → spec_ready → implementation → review → done`. The lead changes phases; nothing closes without an approved review.

## What Seahorse adds to your repo

Setup creates only files that don't exist yet, and never overwrites one.

| Path | What it is |
|---|---|
| `.claude/commands/<prefix>-*.md` | The agents, as Claude Code slash commands |
| `.claude/commands/seahorse-onboard.md`, `seahorse-reflect.md` | Seahorse's two helper agents |
| `orchestrator.json`, `backlog.json` | Project list and backlog (owned by the lead) |
| `orchestrator/memory/core.md` | The rules and the permission matrix (yours to edit) |
| `orchestrator/memory/domain_context.md` | Modules, conventions, constraints, commands, from discovery |
| `orchestrator/memory/lessons.json`, `patterns.json` | Lessons learned and code style, starting empty or from discovery |
| `orchestrator/schemas/`, `orchestrator/templates/` | JSON schemas the agents validate against |
| `orchestrator/projects/` | Empty. The lead creates a folder per project |
| `.seahorse/` | Seahorse's own state: onboarding proposal, feedback, reminders, skill assignments. Add it to `.gitignore` or commit it to share with your team |

## The pages

**Backlog.** Items by status. Drag one onto the Lead to turn it into a project, or onto the Strategist to scope it. Tasks in the active project can be dragged onto the agent they're assigned to.

**Workflow.** The project as five stages, the current one marked, and a handoff log. The box at the top says what to start next, worked out from the files: send a worker's finished report to the Lead, start a task whose dependencies are done, or ask the Lead about blockers. You click every handoff; Seahorse never starts an agent on its own.

**Projects.** Every project with its tasks, timeline, agent messages and review report.

**Agents.** Each agent with what it may write, its skills, pinned lessons and recent work. Start any agent without a task (workers start in consultant mode), or create a new one from a template.

**Skills.** Every plugin in your Claude Code marketplaces, searchable by category and popularity. **Install** adds it to the project (`claude plugin install … --scope project`); **assign** tells chosen agents to use its skills when you start them from Seahorse.

**Lessons.** Mistakes the lead recorded, grouped by topic, each linked to the project it came from and to open backlog items that still break it. **Enforce** sends the lead to search the code for the mistake; **Retire** has it confirm the mistake can't happen any more; **Remind** pins the lesson into an agent's launch prompt.

**Feedback.** What you keep correcting, from three sources: agents record your corrections in their message files, you log dislikes in Seahorse, and reviewer rejections count against the agent whose files they name. When the same complaint comes back on separate occasions, **Ask Claude for a fix** opens `/seahorse-reflect`, which proposes a lesson, a plugin, or a new agent. Nothing changes until you accept one.

## Safety

- Seahorse listens on `127.0.0.1` only.
- Every request that changes anything needs a random token embedded in the page at startup and a `localhost` Host header, so other websites you have open can't trigger it.
- Agent launches are built from fixed text plus ids that must match `[a-z0-9-]` and exist in your files. Nothing you type in the browser reaches a shell.
- Seahorse doesn't edit the agents' working files (`orchestrator.json`, `backlog.json`, project files, `lessons.json`). It writes them only when Setup creates them for the first time. The only existing files it changes are agent files and the message schema, and only when you click **Add the feedback rule**.

## Develop

```bash
npm test          # node --test, no dependencies
node server.mjs /path/to/a/test/repo
```

| Path | What lives there |
|---|---|
| `server.mjs` | HTTP server, file watching, agent launching, plugin and onboarding endpoints |
| `lib/kit.mjs` | Agent templates, `core.md` and `domain_context.md` generators, matrix parser |
| `lib/feedback.mjs` | Collecting feedback and finding repeats |
| `kit/` | The starter files: agent templates, Seahorse's helper agents, schemas, templates |
| `public/index.html` | The whole UI |
| `docs/DESIGN.md` | The visual direction |

## License

[MIT](LICENSE)
