# ADR-031: Demo content language per deployment, and ONE business language that also decides how incoming messages are read

Date: 2026-10-08
Status: accepted (the owner's decisions, 2026-10-07 and 2026-10-08, phase 14 M5). Extends ADR-024 (panel i18n) and ADR-021
(public demo).

## Context

The public demo was Spanish only: Uruguayan suppliers, Spanish messages, Spanish seed texts, Spanish sample files. The
owner wants the public demo in English (a fictional US business) and the Spanish demo kept for clients in Latin America.
Beyond the data, the backend itself had Spanish assumptions in places that decide what the system DOES with a message: the
pre-filter words, the tax / full-list / currency rules of lists, the unit words that tell product variants apart, the
texts of the extraction rules, the fake LLM heuristics and the prompts ("a business in Uruguay and Argentina", "notes in
Spanish"). With English content they would misread it.

## Decisions

1. **The demo content is data, one module per language** (`apps/api/src/modules/demo/content/{es,en}.ts` behind the
   `DemoContent` type): suppliers (each with its currency), customers, the story beats of the review queue, seed texts,
   sample files and senders. The seed and "Try the system" only walk it, so both languages tell the same story.
   `DEMO_CONTENT_LANGUAGE=en|es` picks it **per deployment**; the panel language stays per visitor (ADR-024). Recorded LLM
   answers are keyed by message content, so both languages' goldens share the same folders.
2. **`business.language` is ONE setting for the whole business and it does two things**: it sets the language of the
   messages the system SENDS (as since phase 13) AND the language in which the messages, price lists and spreadsheets that
   ARRIVE are read (pre-filter words, tax basis, "full list" evidence, currencies, availability words, unit words, the
   texts of the rules, the prompt block, the fake provider). This is a **conscious decision**: a business works in one
   language. **Bilingual businesses are out of scope**: with `en`, what a supplier writes in Spanish may stop being
   recognized (and the other way round). The panel therefore says so: the setting is called "Business language" (EN) /
   "Idioma del negocio" (ES), its help explains both effects, and the admin sees a confirmation before changing it.
3. **One language table is active at a time, never a union of words.** `es` keeps exactly the patterns it always had;
   `en` has its own. A union would make a Spanish business read English words as signals (more LLM calls, false
   matches) and would make "does Spanish still behave as before?" unprovable.
4. **Spanish behavior must not change, and it is PROVEN**: `test/legacy-es/` holds frozen verbatim copies of the old
   code, `heuristics-es-identical.test.ts` compares them with today's code (language `es` and no language) over a
   3,409-text corpus built from every test, fixture and the Spanish content, plus random combinations of Spanish words;
   the seed fingerprint (`demo-seed-es.snapshot.json`) proves the Spanish seed; the Spanish prompts keep their
   exact bytes and versions.
5. **Prompts: a block is APPENDED, the base is never edited.** `promptForLanguage` returns the base prompt untouched
   for `es` and `base + language-en.md` otherwise, so the security section of every prompt stays where and as it was and
   the block itself restates that data is data in any language. Prompt-injection detection (`containsInjection`) is
   independent of the business language.
6. **The currency belongs to the content, not to the panel language**: the English content quotes in USD (panel
   "$15.76"), one supplier is Canadian and quotes in CAD (the currency-change review is "CAD → USD"); Uruguayan pesos
   show their code in an English panel ("UYU 15.76").
7. **Defaults**: `DEMO_CONTENT_LANGUAGE` defaults to `en` (development, tests and the public demo); `es` is opt-in.

## Consequences

- Changing the business language in Rules affects how every incoming message is read, from the next message on. The panel
  asks first; the API does not (it is a setting, like every other, audited).
- A business that really mixes languages needs a per-contact language (not designed): out of scope.
- The converters' own warnings (hidden sheets, truncation) are still written in Spanish; they only appear with unusual
  files.
- Adding a language means one `content/<lang>.ts`, one table in each heuristic, one `language-<lang>.md` block and its
  fixtures and recorded answers; the Spanish-identity tests stay as they are.

## Outcome (phase 14 M5, 2026-10-08)

- English content: Kestrelwood Supply Co. (Ohio) and three fictitious suppliers (Corvane Fasteners Inc., Tessaly Paint &
  Coatings, Norvale Electric Supply Ltd. — Canadian, quoting in CAD); fictitious `+1 614 555 01XX` numbers, `.test` /
  `.example` emails, US customary units. Names were checked so that none is a well-known real company.
- Recorded answers: nine real Claude outputs for the English fixtures (US$0.0803 in total, no retries), reviewed by the
  owner before commit; the Spanish ones are untouched (`golden-outputs.test.ts` counts both sets, `golden-outputs-en.test.ts`
  checks the English ones against `en/expected.json` and against the demo content).
- The English content carries its September list and its approved sheet format as DATA, so the seed needs no recording;
  a test proves the recordings say the same as the data.
- Deploy: `deploy/compose*.yaml` pass `DEMO_CONTENT_LANGUAGE` (default `en`). A VM that was seeded in Spanish switches
  language at the next demo reset/redeploy (the seed is rebuilt); nothing is changed on the VM by this repository.
- Known limit: `classifier.md` asks for the `reason` "in Spanish", so an English deployment may store a Spanish reason
  (internal only, not shown in the panel). Fix later with a new prompt version and re-recording the Spanish goldens.
