# Review: Account scope hotfix
> Generated: 2026-10-07T13:00:00Z

## Verdict: APPROVED

## Task task-fix-001: Allowlist fields in invoice updates
### Acceptance Criteria Status
- [x] accountId and id in the body are ignored
- [x] Test covers a cross-account update attempt

### Issues Found
- None. The first pass found the same body spread in `server/src/customers/update.js:14`; it is fixed.
