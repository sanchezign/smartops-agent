# ADR-030: In DEMO_MODE the public operator can resolve the column-mapping review

Date: 2026-10-07
Status: accepted (the owner's decision, 2026-10-07, phase 14, item #4). Amends the permission rule of ADR-018 / phase 8.

## Context

Phase 8 rule (`canResolveReview`): an **operator** resolves review items of scope `line` only; whole-list gates
(scope `run`) and catalog-wide proposals (scope `catalog`) need an **admin**. The public demo logs every visitor in as
the shared operator (ADR-021). The showcase flow — send "a new spreadsheet" from "Try the system", then "Choose the
price column" (`column_mapping`, scope `run`) — ends with "Only an administrator can resolve this review". A visitor
reaches a dead end exactly at the step the README video shows.

## Decision

1. `canResolveReview(role, item, { demoMode })` additionally allows **operator + `demoMode` + scope `run` + kind `column_mapping`** (the only scope that kind has; the least-privilege reading).
   Nothing else changes: with `demoMode` false the result is identical to the phase 8 rule for every role × scope ×
   kind; with it true the ONLY difference is that one combination. Suspicious messages, long documents and
   catalog-wide changes stay admin-only in the demo too.
2. `demoMode` comes from the API configuration (`DEMO_MODE`), never from the request. The panel copies the rule using
   `GET /api/v1/demo/info` (404 outside the demo); a forged panel can at most show a button that answers 403.
3. Tests (the permission matrix is item-level, which the route-level authz matrix did not cover):
   - the full table role × scope × kind × mode, with the invariant "outside DEMO_MODE nothing changed";
   - the panel ↔ API sync test gets the mode as a dimension;
   - the authz matrix gains a per-item section that runs the app with DEMO_MODE off and on, approving and rejecting
     each kind as operator and admin, compared with a fixture and with fixed invariants;
   - an E2E where the public operator resolves the Norte spreadsheet in the demo, with its audit-log entry.

## Consequences

- A column choice made by a visitor is shared by every visitor (one demo database); the automatic demo reset
  restores it, like every other demo change.
- The real system (no DEMO_MODE) keeps requiring an admin for this review.
