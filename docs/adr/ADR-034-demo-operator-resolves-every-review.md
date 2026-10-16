# ADR-034: In DEMO_MODE the public operator resolves every review

Date: 2026-10-15
Status: accepted (the owner's decision, 2026-10-15; implemented in phase 16 M2 after the strictest security review of
the phase).
Amends [ADR-030](ADR-030-demo-operator-resolves-column-mapping.md) (which allowed one combination) and replaces its
"Audit note (2026-10-09)", which was never implemented.

## Context

The public demo logs every visitor in as the shared operator (ADR-021). ADR-030 let that operator resolve the
`column_mapping` review; every other run gate and catalog-wide proposal still needs an admin, so To do shows "Waiting
for an administrator (4)" and the visitor cannot try those reviews. The owner does NOT want a public admin user.

## Decision

1. `canResolveReview(role, item, { demoMode })`: with `demoMode` true an **operator may resolve every review**
   (any scope, any kind). With `demoMode` false the result is **identical to the phase 8 rule for every role × scope ×
   kind**. `demoMode` is `env.DEMO_MODE` (API configuration), never from the request.
2. The panel copies the rule with `GET /api/v1/demo/info` (404 outside the demo). A review that, in a real
   installation, only an admin resolves shows the note **"In a real installation an administrator resolves this"**
   (derived from the same mirror evaluated with `demoMode: false`; the sync test covers both modes).
3. **Unchanged:** Users stays admin-only; Rules (settings writes) stays read-only for the operator; manual opt-in stays
   admin; every route-level role in the route table. Only the item-level rule changes.
4. To do in the demo: the "Waiting for an administrator" section disappears (nothing waits for an admin) and those
   reviews join the yellow counter.
5. `supplierId` / `createSupplier` of `unknown_supplier` / `column_mapping` stay free for the demo operator. The text
   (≤ 200 chars) is rendered escaped, is visible to every visitor until the reset, and the operator already types
   product names.

## Risk review (the strictest of the phase)

| Risk                                                     | Assessment                                                                                                                                                                                                                                  |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Behaviour changes outside the demo                       | Before the rule is touched, the current role × scope × kind table is frozen as a fixture and a test compares it whole with `demoMode` off; the authz matrix approves and rejects every kind as operator and admin with the demo off and on. |
| `suspicious_instructions`                                | Approving re-extracts with the fake provider; every line still goes to review (`suspicious_source`). Worst case: a price set until the reset.                                                                                               |
| `global_change`, `tax_basis_changed`, `mark_unavailable` | Large changes to the shared demo catalog; reverted by the reset; recorded in the audit log.                                                                                                                                                 |
| `unknown_supplier` / `createSupplier`                    | Free text shown to all visitors until the reset (see §5).                                                                                                                                                                                   |
| AI budget (`extraction_failed` retries)                  | **$0**: DEMO_MODE forces the fake LLM and transcriber, and a demo server must not hold a real key (env guard). Only CPU is used: the in-process orchestrator is sequential; rate limits apply.                                              |
| A visitor leaves the demo empty                          | Daily reset + "Reset" button (one per 10 minutes for everyone). An empty To do in the demo offers "Try the system" and "Reset the demo".                                                                                                    |
| DEMO_MODE on a real installation                         | Blocked by the env guards (`*_demo` database, fakes forced, no real keys); a test asserts it.                                                                                                                                               |

## Tests

- `test/unit/review-permissions-frozen.test.ts` + `test/fixtures/review-permissions-demo-off.json`: the whole role ×
  scope × kind table with DEMO_MODE off, generated from the phase 15 code and committed BEFORE the rule changed
  (commit "freeze the review permission table"); no record switch, never regenerated.
- `test/unit/review-permissions.test.ts`: the phase 8 rule restated; in the demo exactly the operator's non-line cells
  differ; only a strict boolean `true` opens it.
- `test/unit/review-permissions-sync.test.ts`: the panel mirror = the API rule, both modes.
- `test/e2e/authz-review-matrix.test.ts`: approve and reject every scope × kind as anonymous / operator / admin with the
  demo off and on, against a fixture and fixed invariants (only the 33 "on / operator / non-line" cells changed; the
  "off" half is identical); a request that claims the demo (query, headers, cookie, body) on an installation without it
  gets 403, and the To do counters still receive `demoMode: false`.
- `test/e2e/authz-matrix.test.ts`: every route answers the same with the demo on; users and settings writes stay 403
  for an operator in both modes.
- `test/unit/demo-mode.test.ts` (existing): the demo forces the fakes, refuses any real key and any database not named
  `*_demo`.
- `test/unit/todo-rules.test.ts`, `test/integration/todo-query.test.ts`: in the demo nothing waits for an admin and the
  operator sees exactly what an admin sees.
- E2E (`reviews.spec.ts`): the public operator processes a suspicious message and applies an across-the-board change
  (their own E2E supplier), and each one is in the audit log as `review.approve` by the public operator's user;
  `todo.spec.ts`: the note on an admin-only item, no folded section, the empty To do with "Try the system" and "Reset
  demo"; `demo-check`: nothing waits for an admin in the demo (once a phase 16 release is deployed).

## Consequences

- A decision made by a visitor is shared by all visitors until the reset (as in ADR-030).
- The real system is untouched.
