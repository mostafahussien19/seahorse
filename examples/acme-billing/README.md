# Acme Billing (example)

A fictional project that is already set up with Seahorse, so you can see every file Setup creates and try the board without onboarding your own repo.

```bash
node server.mjs examples/acme-billing
```

Then open http://localhost:4600. There's no application code here: just the agent team (`.claude/commands/`), its memory and state (`orchestrator/`, `orchestrator.json`, `backlog.json`) and Seahorse's own state (`.seahorse/`).

What you'll find:

- **refund-retries** is the active project. The API agent has finished its task and the lead hasn't read it yet, so the Workflow page suggests sending its report to the Lead.
- **account-scope-hotfix** and **invoice-pdf-export** are closed, with review reports.
- The Web agent has been told three times to use a toast instead of a modal for errors, so Feedback shows a repeat.
