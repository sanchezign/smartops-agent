# ADR-032: Panel triage — To do, Activity, System status

Date: 2026-10-12
Status: accepted (the owner's decisions, 2026-10-12, phase 15). Amends ADR-029 §2 (where the yellow is spent). Does not
change ADR-012 (review rules), ADR-018 / ADR-030 (permissions) or ADR-015 (notifications).

## Context

Real use of the panel showed that "pending reviews" and "open alerts" read as the same thing, and that three different
things were mixed:

1. **Things to decide:** every pending review item, plus the alerts that ask for an action (listen to a voice note by
   hand, an ambiguous opt-out phrase). They lived on two screens with two yellow counters.
2. **News:** a price change already applied, low stock. They added to the yellow "Alerts" counter without asking
   anything, and had to be marked as seen.
3. **Technical errors:** n8n unreachable, failed deliveries, errors of the period. For whoever runs the system, not for
   the owner of the business — yet they sat on the operator's Home.

The Home did not answer "what do I have to do?": four pending tiles, three metrics, two charts and the pre-filter list.

## Decision

Presentation only. The system decides exactly the same: no change to the review service, the ingest, the opt-out flow,
the notifications / WhatsApp digests, the permission rules or the database schema.

1. **Every alert type has one category** (`apps/api/src/modules/admin/alert-category.ts`, an exhaustive map — a new
   `AlertType` does not compile until it is classified here):

   | AlertType           | Category  | Why                                                                                                                                                                                           |
   | ------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `manual_attention`  | action    | "Listen to this voice note by hand": nobody else will. Closed with "Done" (acknowledge).                                                                                                      |
   | `possible_opt_out`  | action    | Compliance: deliberately not applied (ADR-017), a person decides.                                                                                                                             |
   | `price_change`      | info      | Already applied. WhatsApp digests still notify it as before.                                                                                                                                  |
   | `low_stock`         | info      | Restocking happens outside the system; nothing to close in the panel.                                                                                                                         |
   | `missing_data`      | info      | **Not produced by any code** (enum value since phase 2). Missing fields already become review items (`missing_currency`, `uncertain_value`); in To do it would be a yellow nobody can act on. |
   | `integration_error` | technical | n8n unreachable, workflow errors.                                                                                                                                                             |
   | `ingestion_error`   | technical | **Not produced by any code**. The business side of a failed list is already the `extraction_failed` review.                                                                                   |

   `missing_data` and `ingestion_error` stay in the enum (no migration). A unit test fails if API code starts creating
   them, so whoever adds a producer revisits their category on purpose.

   Every review kind is **action** by definition (it waits for a decision). `extraction_failed` was the borderline one
   (a technical failure), but it blocks a supplier's list and "retry or discard" is a business decision: it stays in To do.

2. **To do** (`/todo`) = pending review items + open **action** alerts, grouped by list (one ingestion run = one message:
   a photo, a spreadsheet, a voice note), newest first, the supplier as the card heading. Its counter is the ONLY yellow
   counter of the navigation and counts **what the current user can resolve**, computed by the API with the same
   `canResolveReview(role, item, { demoMode })` (ADR-030). Items the user cannot resolve are shown in a folded section
   "Waiting for an administrator (N)", without yellow. Acknowledging an alert is allowed to every role (unchanged), so
   action alerts always count. Empty state: "All caught up".
   A **Resolved** link opens the history of approved / rejected items (what the old Reviews status filter showed).

3. **One-click decisions from the list** only where approving with an empty body does exactly what the row shows, with
   nothing to choose. Buttons carry a concrete verb with the value, never "Yes / No":
   - `price_outlier` and `currency_changed` (scope line), only when the line has a linked product AND a proposed price:
     "Update to $91.00" / "Keep $45.50"; `currency_changed` shows both currencies. (Approving a line without a product
     creates a new product — never from one click.)
   - `mark_unavailable` (admin): "Mark unavailable" / "Keep available".
   - `manual_attention`: "Done" (acknowledge), with the link to the voice note.
   - `possible_opt_out`: "Not an opt-out" (acknowledge). Opting the contact out asks for confirmation: an operator can
     opt out but only an admin can opt back in.
     Everything else is decided in the detail: `stale_source` (approving writes a price from an OLDER message over a newer
     one — the case to look at calmly), `uncertain_value`, `missing_currency` (approving would pick the currency silently),
     the product-matching kinds, `pct_without_match`, `column_mapping`, `unknown_supplier`, `global_change`,
     `tax_basis_changed` (re-runs the whole list), `suspicious_instructions` (security) and `extraction_failed` (spends AI
     budget). One-click buttons are shown only when `canResolve` allows them; 403 and 409 `STALE_REVIEW` answers are shown
     on the row with a link to the detail.

4. **Activity** (`/activity`) = **info** alerts: a feed, no yellow, nothing to mark as seen.

5. **System status** (`/system`) = **technical** alerts and the errors of the period. In the navigation for admins; in
   the public demo (DEMO_MODE) also for the operator, read-only. No navigation counter: the admin's Home shows one red
   line ("danger" token, never yellow) when there are unreviewed errors. The API routes and roles do not change (an
   operator can still acknowledge through the API, as before); this only decides what the panel offers.

6. **Home** keeps its name and its 7 / 14 / 30-day metrics; the pending block (first tasks or "All caught up") goes on top.

7. **Routes:** `/reviews` (the list) → `/todo` and `/alerts` → `/activity` are redirects (`legacy-routes.ts`, like the old
   Spanish routes); `/reviews/[id]` stays. Panel links computed by the API for digests point to `/todo` or `/system`.

8. **API, read-only and additive:** `GET /api/v1/admin/todo` (counters + groups + action alerts, every role), a `runId`
   filter on `GET /admin/reviews`, a `category` field and filter on `GET /admin/alerts`. No new table or column: the
   category is a static function of the type, the groups use the existing `ingestionRunId`.

**Amends ADR-029 §2:** the yellow counter of the navigation is the To do counter (it replaces the Reviews and Alerts
counters). The rest of §2 stands.

## Consequences

- One place to look for what waits for a person; news and technical errors stop competing for the yellow.
- The public demo's operator no longer sees a counter of things it cannot do.
- Old links keep working (redirects; digest links are computed when read).
- Guards: the classification test (exhaustive, plus "the dead types are not produced"), the item-level permission
  matrix of ADR-030 untouched (it must stay green unchanged), the route-level authz matrix gains the new read route.
- Not covered (would need state, i.e. a schema change): unread markers per user in Activity, and orders / customer queries
  as tasks with a status. They stay in Conversations and in the WhatsApp digests.
