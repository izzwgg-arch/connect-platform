# Tests run

One entry per task that ran tests, newest first. Say what ran, the pass/fail count, what
was DEPLOYED and verified, and what is NOT proven. Green tests are not proof that a human
can do the thing; say so.

## Project rules adopted from Connect — 2026-09-17

- No code changed; no test suite run.
- `npx vitest run` is the runner for `tests/*.test.ts` (no npm script exists yet).
- Local DB: `npm run db:push` applied the `originalTotalAtConversion` column that came in
  with the 2026-09-17 sync; Prisma Client regenerated. Not a test.
- NOT proven: nothing in this task is user-visible.
