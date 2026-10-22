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
