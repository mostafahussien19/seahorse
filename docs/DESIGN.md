# Seahorse board: design direction

Chosen by the project owner on 2026-10-22: **lab notebook**.

- **Identity:** Seahorse is named after the hippocampus (Greek for seahorse), the part of the brain that turns short-term experience into long-term memory. The board is the notebook where the agents' work gets recorded.
- **Mood:** warm paper tones, a serif display face, quiet and editorial. Like a neuroscience lab notebook, not a SaaS dashboard.
- **Themes:** light (paper) and dark (lamplight), with a toggle.
- **Dial:** ENERGY 2 / RHYTHM 2 / MOTION 1

## Decisions (one line each)

- **Palette:** paper and ink neutrals, blue-black ink for anything you can act on, oxblood as the single accent for "needs attention" (critical items, live drop targets). Nothing else.
- **Type:** system book serif (Iowan Old Style / Palatino) for the wordmark and headings, because it carries the notebook voice and works offline; system sans for card text, because it's denser to scan; mono only for IDs and commands, because they are literal identifiers.
- **Motif:** a double rule under headings, like a ledger or notebook page header, repeated on every view and in the detail panel.
- **Cards:** flat index cards with a thin rule border and a small 4px radius. There are no shadows, because nothing on a notebook page floats. The one exception is the detail panel, which really does sit above the page.
- **Motion:** border and background colour changes on hover and drag only.

## Dashboard usability

- **Frame:** a paper sidebar groups Work, Team and Memory. The lighter working sheet holds the page content; utility controls stay in the sidebar footer. On phones, navigation folds behind Menu.
- **Starting point:** configured workspaces open on Workflow, with the next handoff, recorded task totals and workflow stages together.
- **State language:** an agent's completion report is distinct from a Lead-confirmed task update. Show “awaiting Lead” until the project state catches up; file watching does not imply a live agent process.
- **Backlog:** handoff targets and active-project tasks are expandable so planning stays visible. Dragging reveals the handoff targets automatically; opening a card provides the keyboard and touch alternative.
- **Search:** workspace search covers backlog items, project tasks, projects, lessons and agents. Command/Control K opens it; slash focuses the current view's search or opens workspace search.
- **Continuity:** live updates preserve expanded reports, form text, focus and the reading position in detail panels. A failed refresh keeps the last loaded view and offers Retry.
- **Keyboard:** detail panels contain focus, make the background inert, close with Escape and restore focus to the initiating control.
