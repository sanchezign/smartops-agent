# Costs

What SmartOps Agent costs to run: the $0 public demo, and an estimate for a real client. Prices
were checked on 2026-09-28 on the providers' own pages (links below). They change, so check them
again before quoting a client.

## The public demo: $0

The demo server is being set up (phase 12); these are the services it uses.

| Item                  | Service                                                                          | Cost |
| --------------------- | -------------------------------------------------------------------------------- | ---- |
| Server                | Oracle Cloud Always Free E2.1.Micro VM (1/8 OCPU, 1 GB; ADR-023)                 | $0   |
| Storage and traffic   | Always Free block volume (200 GB) and outbound data (10 TB / month)              | $0   |
| Domain and HTTPS      | DuckDNS subdomain, Let's Encrypt certificates (Caddy)                            | $0   |
| AI and speech-to-text | `DEMO_MODE` forces fake providers with recorded outputs                          | $0   |
| WhatsApp              | Not used: the demo has its own simulated Graph API                               | $0   |
| CI/CD                 | GitHub Actions on a private repository (≈ 830 of the 2,000 free minutes a month) | $0   |
| Monitoring (planned)  | UptimeRobot and Healthchecks.io free plans                                       | $0   |

A budget of USD 1 with alerts is set in the Oracle account, so any unexpected charge is visible
at once. Total real AI spend while building the project: **$0.24** (Claude, recorded in the
`ai_usages` ledger).

## A real client: monthly estimate

Assumptions for a small distributor: about 200 price lists and 300 voice notes (30 s on average)
a month, plus team digests, one WhatsApp number and a few panel users.

| Item                  | Estimate          | How it is computed                                                                                                                                                                                                                                              |
| --------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting               | about **$27–30**  | On Render: three services (API, worker, n8n) at the Starter size ($7 each) + Postgres Basic-256mb (about $6) + storage ($0.30 per GB). n8n used about 350 MB in the demo, so on 512 MB it is tight: a bigger plan or one paid VM for everything may fit better. |
| Panel                 | $0                | Served by the same server. If it moves to Vercel, the Hobby plan is for personal, non-commercial use only, so a client needs Pro.                                                                                                                               |
| Claude (Sonnet 5)     | about **$3–5**    | $2 per million input tokens, $10 per million output tokens. Measured: a price list costs $0.012–$0.017 to extract. A new spreadsheet format costs about $0.011 once; after that, lists in that format cost $0.                                                  |
| Speech-to-text (Groq) | about **$0.30**   | Whisper large v3: $0.111 per hour of audio on the paid developer plan. 300 × 30 s = 2.5 h. The free plan (2,000 requests a day) may be enough.                                                                                                                  |
| WhatsApp              | depends on volume | See below.                                                                                                                                                                                                                                                      |

**WhatsApp (Meta)**: Meta charges per delivered message. The rate depends on the category and on
the recipient's country; Uruguay is in the "Rest of Latin America" rate card. Business-initiated
template messages (marketing, utility, authentication) are charged. On **October 1, 2026** Meta
starts charging per message for service messages and for utility messages inside the 24-hour
customer service window, with no free allowance. Before that date they are free. The rates by
market are in Meta's rate card. For this project that covers supplier acknowledgements, opt-out
confirmations, replies written in the panel and the team digests. Count them for the client and
price them with the current rate card: no figure is assumed here.

**Coexistence** (the same number used in the WhatsApp Business app and by the system) needs a
Solution Partner or Tech Provider. The options and their costs are in
[coexistence-client-guide.md](coexistence-client-guide.md).

## Sources

- [Oracle Cloud Always Free resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
- [Render compute plans](https://render.com/docs/compute-plans) and
  [Render: how much does hosting cost](https://render.com/articles/how-much-does-cloud-application-hosting-cost-for-small-businesses)
  (Starter from $7/month; Starter + Basic-256mb Postgres about $13/month; storage $0.30/GB)
- [Vercel Hobby plan](https://vercel.com/docs/plans/hobby) (personal, non-commercial use)
- [Groq Whisper large v3](https://console.groq.com/docs/model/whisper-large-v3) ($0.111 per hour
  on the developer plan)
- Claude pricing ($2 / $10 per million tokens for Sonnet 5): checked on 2026-09-25, recorded in
  `apps/api/src/ai/pricing.ts` (the API refuses to start with a model that has no price)
- [WhatsApp Business Platform pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing)
  and
  [the changes for service and utility messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/non-template-messages)
