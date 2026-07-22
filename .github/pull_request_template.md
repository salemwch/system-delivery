## What and why

<!-- What changes, and what problem it solves. Link the doc or ADR it implements. -->

## Checklist

Derived from the Definition of Done in `docs/10-development-roadmap.md` §8 and
the engineering standards in `CLAUDE.md`.

- [ ] `pnpm verify` and `pnpm test` pass locally
- [ ] No `TODO`, stubbed bodies, or placeholder returns
- [ ] No `any`, no `@ts-ignore`, no non-null `!` assertions
- [ ] Failure paths covered, not just the happy path
- [ ] **Cross-tenant isolation test added** if this touches tenant-scoped data
- [ ] Any new tenant-scoped table has `tenant_id NOT NULL` + RLS `ENABLE` **and** `FORCE`
- [ ] Money uses integer minor units with the exponent from the `currencies` table
- [ ] Mutating endpoints are authenticated, authorised, ownership-checked, and idempotent
- [ ] No PII in logs
- [ ] Migration is forward-only (applied migrations are immutable — checksum-enforced)
- [ ] Docs updated if a documented decision changed

## Verification

<!-- What you actually ran, and the result. "Tests pass" is not evidence; paste it. -->
