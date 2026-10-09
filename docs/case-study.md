# Case study: SmartOps Agent

(Versión en español: [caso-de-estudio.md](caso-de-estudio.md).)

## The problem

Small distributors and hardware stores run on WhatsApp. Suppliers send price lists as photos of
printed pages, PDFs, spreadsheets in their own layouts and voice notes. Customers ask for prices
and place orders in the same chats. Someone copies prices into a spreadsheet by hand, orders get
lost between messages, and nobody notices a 20 % increase until the margin is gone.

## The goal

An operations agent that reads what arrives over WhatsApp, keeps the catalog up to date, tells
the team only what needs action, and works next to the people who answer the same number. It had
to be built to the standard of a delivery to a real client, and the public demo had to run at
**$0** of infrastructure.

## The approach

- **The backend decides; the AI reads.** Claude extracts structured data, validated against a
  schema. Every rule (duplicates, outliers, currency, VAT basis, full list vs partial update)
  lives in tested code, never in a prompt or in the orchestration.
- **Never guess.** Doubtful values, uncertain matches, new spreadsheet formats and suspicious
  messages become review items with the original message beside them.
- **Spend only where it helps.** A deterministic pre-filter keeps greetings, stickers and
  customer chat away from the AI. Spreadsheets in a known format are read by code. Spend caps are
  checked before every call.
- **Reliable by construction.** Webhooks are stored before answering, work goes through queues
  with backoff and dead letters, and a transactional outbox hands work to n8n. Every step is
  idempotent.
- **People first.** A person's reply pauses only the automatic answers in that chat, opt-outs
  are respected, and the team receives one summary per window.

## Architecture in one paragraph

An Express 5 + TypeScript API owns the WhatsApp webhook, the rules and every write to PostgreSQL.
A worker (pg-boss queues in the same database) downloads media, transcribes voice notes (Whisper
on Groq), converts documents in an isolated thread and sends messages. n8n orchestrates the
receiver, processor and notifier agents by calling the API's internal endpoints. A Next.js panel
(English and Spanish, mobile first) shows reviews, conversations, the catalog and rules, updated
live over SSE. Details: [architecture.md](architecture.md).

## Results (measured)

- **AI cost:** about $0.32 of Claude credits in total to build and test the whole project, recorded
  call by call. A typical price list costs $0.012–$0.017 to extract. A new spreadsheet format
  costs about $0.011 once, and $0 afterwards.
- **Accuracy on the test data:** a September PDF followed by an October photo produced exactly
  the expected 5 automatic price changes and 2 alerts, sent 1 doubtful product to review and left
  an absent product untouched.
- **Prompt injection:** 8 of 8 cases passed against the real model (6 attacks, 2 controls). The
  attacks were flagged and stopped for review, and no invented price was applied.
- **Tests:** 1,098 API unit and HTTP tests and 222 against a real Postgres; 121 panel unit tests
  and 86 browser tests on desktop Chrome, Pixel 7 and iPhone (WebKit), with accessibility checks
  in both languages. Mutation score 80 %.
- **Resilience:** with n8n stopped and restarted, every message was delivered once, with one run
  each.
- **Demo infrastructure:** designed to run on an Oracle Cloud Always Free VM (the whole stack
  used about 0.7 GB of memory in a local deployment test).

## What was hard, and what I learned

- **Meta disabled the business account** on day one (a false positive on a new account). The
  review was resolved, but development continued meanwhile against a local WhatsApp simulator
  that signs webhooks and imitates the Graph API. It is still the default way to develop.
- **Real time through a tunnel:** Cloudflare's edge held GET event streams while POST streams
  flowed in about 75 ms. The panel now opens its event stream with POST and falls back to
  refreshing every 30 seconds.
- **A CI job that hung for 24 minutes:** pnpm 12 starts child processes in a new process group,
  so Playwright could not stop its web servers. The web servers now start without pnpm.
- **Spreadsheets:** "1.850" can mean one thousand eight hundred fifty or 1.85. The system never
  guesses: it reads the supplier's format once, with a person choosing the price column, and
  refuses ambiguous numbers typed by hand.
- **Cloud capacity:** the free ARM region had no capacity for days. A retry script with a
  least-privilege user tries every few minutes and stops on any error that is not capacity.

## What comes next

Before a real client: multi-factor authentication, splitting long PDFs into blocks, data
retention policies, and checking WhatsApp's per-message prices (they change on October 1, 2026).
The costs of a client deployment are estimated in [costs.md](costs.md).
