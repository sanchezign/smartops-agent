# Changelog

All notable changes to this project are documented here. From v0.11.0 on, this file is
maintained by [release-please](https://github.com/googleapis/release-please) from the
[Conventional Commits](https://www.conventionalcommits.org/) history: one version for the
whole repository (API, panel and images share it). v1.0.0 is reserved for the deployed and
audited public demo.

## [0.17.2](https://github.com/sanchezign/smartops-agent/compare/v0.17.1...v0.17.2) (2026-10-09)


### Documentation

* complete Spanish README (how it works, engineering, stack, local run, full documentation list) ([5046f79](https://github.com/sanchezign/smartops-agent/commit/5046f7914297c51830bc94a0d8330ab36fcb86f6))
* current test counts and coverage in the case study and testing docs ([ba430b5](https://github.com/sanchezign/smartops-agent/commit/ba430b54e53578bd03dde3544bc7723f9aabd30b))
* current test counts in both READMEs ([91e7398](https://github.com/sanchezign/smartops-agent/commit/91e7398c6fdf97b7495100a0e3acee0e329e26db))
* the new public repository in CLAUDE.md and F-02 closed in the audit ([6f5d1f6](https://github.com/sanchezign/smartops-agent/commit/6f5d1f6777430baf2f42b2b0d6cd40d29a6327c8))

## [0.17.1](https://github.com/sanchezign/smartops-agent/compare/v0.17.0...v0.17.1) (2026-10-09)


### Bug Fixes

* **admin:** README and guide media are taken without the E2E test suppliers ([5dcd72a](https://github.com/sanchezign/smartops-agent/commit/5dcd72a755604efe6315727191b7d39f893ed81a))
* **deps:** update dependency next to v15.5.27 [security] ([fab70ef](https://github.com/sanchezign/smartops-agent/commit/fab70ef44051875aca887b2a74296d400efe20cc))
* **docker:** upgrade perl-base to deb12u4 in the images and drop the Perl exceptions ([e91af7a](https://github.com/sanchezign/smartops-agent/commit/e91af7aa2f9ed5da63546afc969ce67ba635036c))


### Documentation

* claims the code backs, and the audit's pre-client items ([7839b92](https://github.com/sanchezign/smartops-agent/commit/7839b9204e8c294fa1f65bbb72f0da3d85640cca))
* point commit references to the rewritten history ([6cde458](https://github.com/sanchezign/smartops-agent/commit/6cde4581f2608786fcfa5760d350bd94dab6ee00))
* redact cloud account details and close the launcher cleanup ([63a778e](https://github.com/sanchezign/smartops-agent/commit/63a778ec8fe5a2e4bfde9f3a0b686dd1a29e8cc5))
* **security:** F-02 confirmed and fixed in HEAD, history cleaned via a new repo ([4270985](https://github.com/sanchezign/smartops-agent/commit/42709856e48564a3077e2c08050f943c89552177))
* **security:** final pre-publication security audit (2026-10) ([3aae872](https://github.com/sanchezign/smartops-agent/commit/3aae872d8a11fa0e4f55e56127e9430ddadcfe2f))
* Spanish README with a language selector ([c57e751](https://github.com/sanchezign/smartops-agent/commit/c57e7517c6cbaabac71ddc96b8da829b4e9c2f06))
* total AI spend is about $0.32 (English goldens included) ([9f066d9](https://github.com/sanchezign/smartops-agent/commit/9f066d9c4a17c478c8493e2f2daff19e086bf3eb))


### Tests

* **api:** only fake phone numbers in code comments, tests and the corpus ([cd27008](https://github.com/sanchezign/smartops-agent/commit/cd27008da9063dd3d3c43800761732f9a5478672))

## [0.17.0](https://github.com/sanchezign/smartops-agent/compare/v0.16.2...v0.17.0) (2026-10-08)


### Features

* **admin:** phase 14 M1 — Señal tokens, Archivo, shell and login ([c1d10db](https://github.com/sanchezign/smartops-agent/commit/c1d10dbe48760693eccea7ffaa75b724a6198bf6))
* **admin:** phase 14 M2 — Home with pending groups, sample-data mark and nav counters ([e3bfcd5](https://github.com/sanchezign/smartops-agent/commit/e3bfcd55c319b561c3f551db7f9ba12800b5ebef))
* **admin:** phase 14 M3 — framed list rows, compact sticky chat header, canceled is not an error ([5373cf9](https://github.com/sanchezign/smartops-agent/commit/5373cf9a246eaccd306ad718e35da91e14df47c0))
* **admin:** phase 14 M4a — demo entry: English credentials, one-click sign-in, suggested path ([8e2dd5e](https://github.com/sanchezign/smartops-agent/commit/8e2dd5ef5200dcb2e84c4eb495439c83a165c3da))
* **admin:** phase 14 M5e — E2E on the English content, regenerated README and guide media, deploy language ([c3e5c2a](https://github.com/sanchezign/smartops-agent/commit/c3e5c2ac8f351570c83b30b460319507c3d5524d))
* **admin:** phase 14 M6 — product, review detail, rules, users, opted out, panel 404/error, UYU in English ([244525d](https://github.com/sanchezign/smartops-agent/commit/244525d221f1678eb44466fe21b955866980cdd9))
* **admin:** the business language says what it does, and asks before it changes (ADR-031) ([f80bb6a](https://github.com/sanchezign/smartops-agent/commit/f80bb6ab67ad32f94dfe46bfa820d7478a682878))
* **api:** phase 14 M4b — in DEMO_MODE the operator can resolve the column-mapping review (ADR-030) ([22779a7](https://github.com/sanchezign/smartops-agent/commit/22779a7d48b3590da729770bc628b05785d66726))
* **api:** phase 14 M5b — language-aware heuristics (one language table at a time) and an English prompt block ([3fe4d84](https://github.com/sanchezign/smartops-agent/commit/3fe4d847526236fc2a1449368fe06ab24c0b9e56))
* **api:** phase 14 M5c — English demo content and fixtures (no recordings yet) ([52b7250](https://github.com/sanchezign/smartops-agent/commit/52b725075c887063659bb4f7b0a78d5f63068af1))
* **api:** phase 14 M5d — recorded English goldens and their alignment tests ([c09f3ab](https://github.com/sanchezign/smartops-agent/commit/c09f3abca32e35fd45423a7521398bcc63792647))


### Bug Fixes

* **admin:** tax wording in the English panel; docs: demo-check moves into the repo ([f021f7f](https://github.com/sanchezign/smartops-agent/commit/f021f7f2799c15debeed48eaf6ca182f5df6b490))
* **api:** deterministic demo seed (catalog refs follow the declared product order); fingerprint of the Spanish seed ([3450c59](https://github.com/sanchezign/smartops-agent/commit/3450c5948fdeb3c2dbb3d2e141c67acd2cd60efd))
* **deploy:** keepalive.sh test refuses to start while a run is in progress; trial evidence ([3036b0a](https://github.com/sanchezign/smartops-agent/commit/3036b0a93e123ca9dc29c750a3d13d3f89b40dfd))


### Documentation

* **deploy:** close phase 12, Oracle Free Trial checklist, phase 14 next ([9d897c2](https://github.com/sanchezign/smartops-agent/commit/9d897c2414d5e1050d81cf18777ae8649e0dadb4))
* **deploy:** ephemeral public IP fallback and expected bucket size in the Oracle checklist ([30f9274](https://github.com/sanchezign/smartops-agent/commit/30f9274f4a590558840314771b328ed7fb565ade))
* phase 14 M5c status and phase log ([bc957cd](https://github.com/sanchezign/smartops-agent/commit/bc957cd99f2348637ed3a646119f5012d2692114))
* **phase-14:** M0 — ADR-029 visual identity, ADR-030 demo column-mapping permission, shots spec ([6348945](https://github.com/sanchezign/smartops-agent/commit/634894522ed17c321a9719e6f598862949ef3bbd))


### Tests

* **admin:** phase 14 M7 — accessibility of every screen, light and dark; docs and coverage ratchet ([13a59cd](https://github.com/sanchezign/smartops-agent/commit/13a59cdc374a86cdb4cbf2af2ab81acb48c80343))
* **api:** phase 14 M5a — fingerprint of the Spanish demo seed, taken BEFORE the content becomes data ([08f98ad](https://github.com/sanchezign/smartops-agent/commit/08f98ad8d9fae9eb3ef68ca17ebc0899bfbde6d0))

## [0.16.2](https://github.com/sanchezign/smartops-agent/compare/v0.16.1...v0.16.2) (2026-10-06)


### Bug Fixes

* **deploy:** raise the keep-alive CPUQuota to 50% (the Console averages both vCPUs) ([835cfce](https://github.com/sanchezign/smartops-agent/commit/835cfcedecf6cb0c3ac40b936fea7ec2dc4b73eb))


### CI/CD

* **security:** diff-mode audit gate, Trivy as a PR warning, exception maximum life ([7ad4199](https://github.com/sanchezign/smartops-agent/commit/7ad419971cdc75cb446eec2ddf010f8c02a5f451))
* **security:** nightly scan of main and the published images, daily base-image digests ([e1854bf](https://github.com/sanchezign/smartops-agent/commit/e1854bfbe7b008a803165c6a47d32451f0c3ad33))


### Documentation

* **security:** ADR-028 security alerts policy, nightly scan runbook and 60-day note ([d1e7426](https://github.com/sanchezign/smartops-agent/commit/d1e7426f5a5eeebd51e839fe99fbd5e09bb7027b))

## [0.16.1](https://github.com/sanchezign/smartops-agent/compare/v0.16.0...v0.16.1) (2026-10-06)


### Bug Fixes

* **deps:** move shadcn to devDependencies and update @modelcontextprotocol/sdk to 1.32.1 ([305dbcd](https://github.com/sanchezign/smartops-agent/commit/305dbcd33a260c55d2d9b76d19735987eee17e2c))
* **deps:** update sharp to 0.35.5 and source-map-js to 1.2.2 ([c735591](https://github.com/sanchezign/smartops-agent/commit/c735591c61344130eadcd12ef7b6a78928579eeb))
* **docker:** bump node base image digest, accept seven Perl CVEs for 7 days ([57f43be](https://github.com/sanchezign/smartops-agent/commit/57f43beef6bdcc800ac172975c2d0bb33e59d73e))
* **docker:** remove npm, npx and corepack from the runtime images ([2da7b97](https://github.com/sanchezign/smartops-agent/commit/2da7b97a3c990a151dd2d349a5435792d30c03a5))


### Documentation

* record the Perl Trivy exceptions and drop the libpcre2 one in CLAUDE.md ([9a8f81a](https://github.com/sanchezign/smartops-agent/commit/9a8f81a1421224f5207899b49fc46c65a92b9b98))
* slim CLAUDE.md to 31 KB and move closed history to docs/history/ ([5ec432d](https://github.com/sanchezign/smartops-agent/commit/5ec432d545b21da94d75933a79f7a16bba57c49d))

## [0.16.0](https://github.com/sanchezign/smartops-agent/compare/v0.15.0...v0.16.0) (2026-10-04)


### Features

* **deploy:** nightly keep-alive CPU load, off by default, and the calibration conclusion (phase 12 M7) ([fd611fa](https://github.com/sanchezign/smartops-agent/commit/fd611faafe1b7624873ff00ce734ff46556ea05f))


### CI/CD

* time-boxed Trivy exception for CVE-2026-103111, scan both images before failing ([2cc8972](https://github.com/sanchezign/smartops-agent/commit/2cc897266980caf7a5ec690518234b03292236dd))

## [0.15.0](https://github.com/sanchezign/smartops-agent/compare/v0.14.0...v0.15.0) (2026-10-03)


### Features

* **deploy:** CPU calibration tool and guide, demo URL in the docs (phase 12 M7) ([726d3c8](https://github.com/sanchezign/smartops-agent/commit/726d3c82ae1d446a49ad2cb3d8eff81c2638f485))


### Bug Fixes

* **deploy:** edge body limit equal to the API's, status table header, abuse-check content type ([b8000d2](https://github.com/sanchezign/smartops-agent/commit/b8000d2547243c2fede690b68477d7d71d0ace0e))


### Documentation

* **security:** why the public demo stays at Observatory B+, what would raise it, roadmap ([41564cc](https://github.com/sanchezign/smartops-agent/commit/41564cca1012fbb7abb26c7b7cded87044adb970))

## [0.14.0](https://github.com/sanchezign/smartops-agent/compare/v0.13.0...v0.14.0) (2026-10-03)


### Features

* **deploy:** monitoring setup, hc-test.sh and a bounded abuse/load check (phase 12 M6) ([641df81](https://github.com/sanchezign/smartops-agent/commit/641df810774fc3c2c6b8dc71552a20a0dd1c74cc))


### Bug Fixes

* **deploy:** backup selftest judges overwrite by the object, not by the CLI exit code ([1ab87a1](https://github.com/sanchezign/smartops-agent/commit/1ab87a12ceadd3d36e2849a14fdc3a47eacf5360))
* **deploy:** restore-test accepts the folder prefix a browser download adds ([130cd62](https://github.com/sanchezign/smartops-agent/commit/130cd6267c525f098642ea5608e9fd0ecbe26820))


### Documentation

* record M5 closing and M6 preparation ([735ea10](https://github.com/sanchezign/smartops-agent/commit/735ea1032e0462c04013e80a53affe10aeb94e72))

## [0.13.0](https://github.com/sanchezign/smartops-agent/compare/v0.12.3...v0.13.0) (2026-10-03)


### Features

* **deploy:** append-only backups to Object Storage (phase 12 M5) ([5c28241](https://github.com/sanchezign/smartops-agent/commit/5c2824174ae7054a4b49a695fac863565f09420b))
* **deploy:** on-demand Bastion tunnel with a least-privilege IAM user (phase 12 M3b) ([4958f31](https://github.com/sanchezign/smartops-agent/commit/4958f314dbe890d0ff5e287deeab091e47e25d5a))


### Bug Fixes

* **deploy:** Bastion tunnel retries while the session spreads its key, never shares the console ([662c830](https://github.com/sanchezign/smartops-agent/commit/662c830887faca6f266d6ac0ca32079bdc1dff8f))
* **deploy:** interactive ssh uses only the option set proven on the VM; -SshDebug logs every attempt ([bbaeb99](https://github.com/sanchezign/smartops-agent/commit/bbaeb995affe4745ddcf128055d4726379132711))
* **deploy:** validated apt timer drop-ins (OnCalendar had only the minutes) ([d594361](https://github.com/sanchezign/smartops-agent/commit/d5943614ebf46439d974d44859178959f82e0aad))
* **deploy:** wait for a usable Bastion tunnel and retry an ssh that never got established ([3a5be1e](https://github.com/sanchezign/smartops-agent/commit/3a5be1e36803c4fa49990dfa408a735a53eb1fa5))


### Documentation

* Bastion first real runs, how to test the tunnel again ([0784ef0](https://github.com/sanchezign/smartops-agent/commit/0784ef001ee7a7ab90075caaf9ce4ed8ee316575))
* **deploy:** final Bastion policy, verified security updates, backup resources via the web console ([3fa3543](https://github.com/sanchezign/smartops-agent/commit/3fa35438a3b29a679c5230ce181684ef13ba7446))

## [0.12.3](https://github.com/sanchezign/smartops-agent/compare/v0.12.2...v0.12.3) (2026-10-02)


### Bug Fixes

* **ci:** publish job checks out the tag and does not cancel the other app ([8b4511d](https://github.com/sanchezign/smartops-agent/commit/8b4511d9e2ed8cb87a8d1fece025bd807f2ac0be))

## [0.12.2](https://github.com/sanchezign/smartops-agent/compare/v0.12.1...v0.12.2) (2026-10-02)


### Bug Fixes

* **ci:** call the image version check with bash ([474b6e0](https://github.com/sanchezign/smartops-agent/commit/474b6e0f2811a544cc14046115f41b1badc339f0))


### Tests

* **admin:** E2E login waits for hydration before filling ([96c6d35](https://github.com/sanchezign/smartops-agent/commit/96c6d35cc26f56be9c6ff7fa1488179dafa6be76))

## [0.12.1](https://github.com/sanchezign/smartops-agent/compare/v0.12.0...v0.12.1) (2026-10-02)


### Bug Fixes

* **ci:** published images declare the release version ([e52b397](https://github.com/sanchezign/smartops-agent/commit/e52b397cdcb7c13e7ec476c8f6a4224d946e324e))

## [0.12.0](https://github.com/sanchezign/smartops-agent/compare/v0.11.0...v0.12.0) (2026-10-02)


### Features

* **admin:** English panel routes with permanent redirects; review adjustments (phase 13) ([4521143](https://github.com/sanchezign/smartops-agent/commit/45211437479f0cade4cbbb5677565505e2903086))
* **api:** light demo mode with an in-process orchestrator (phase 12 M2.1) ([5bf4e08](https://github.com/sanchezign/smartops-agent/commit/5bf4e0883ca78256b1b93838d559d8133e86fc45))
* **demo:** one public demo reset per 10 minutes for everyone; M1 Oracle guide (phase 12) ([d635081](https://github.com/sanchezign/smartops-agent/commit/d63508187211ede6b22687f40c3bd77f6d7eb464))
* **deploy:** automatic retry to create the demo VM with a least-privilege OCI user (phase 12 M1) ([f2b8d15](https://github.com/sanchezign/smartops-agent/commit/f2b8d15a015681573cbd518ed498b9933c60a7d6))
* **deploy:** light profile for a 1 GB machine (phase 12 M2.2) ([6a50bad](https://github.com/sanchezign/smartops-agent/commit/6a50bad33936202b595c0a201d82c8bef4292931))
* **deploy:** micro profile trims unused services and tightens SSH (phase 12 M3 prep) ([fe4fe1f](https://github.com/sanchezign/smartops-agent/commit/fe4fe1f249ce34739f3e66fd1f8c80f47f6f03a4))
* **deploy:** public demo bundle, shared-account safety and local deploy harness (phase 12 M0) ([21c3d4d](https://github.com/sanchezign/smartops-agent/commit/21c3d4d2da5a1656a954c477edcc248a547a6327))
* **i18n:** business language for WhatsApp texts; panel writes API texts (phase 13 M3) ([851da15](https://github.com/sanchezign/smartops-agent/commit/851da15d637f4fe64f715af97ff271896674ee97))
* **i18n:** every panel text in English and neutral Spanish (phase 13 M2) ([c935840](https://github.com/sanchezign/smartops-agent/commit/c93584058a243a6b4d1ef6803181c15d8d5a049b))
* **i18n:** panel in English and Spanish with a per-user language (phase 13 M1) ([9dec1ce](https://github.com/sanchezign/smartops-agent/commit/9dec1ce2c4a9d56045a380a06f91f2fc260a28d8))


### Bug Fixes

* **deploy:** host-setup waits for the apt lock, moves apt-daily to the small hours, masks packagekit ([98d64bf](https://github.com/sanchezign/smartops-agent/commit/98d64bf04eaa3f845d496f23318d640fdc3e977c))
* **deploy:** launch retry treats network failures as transient; 2-5 min waits (phase 12 M1) ([842138c](https://github.com/sanchezign/smartops-agent/commit/842138c98f212b6e47a7bb6cf286720c2f169741))


### Documentation

* case study in English and Spanish (phase 13 M8) ([5a11a68](https://github.com/sanchezign/smartops-agent/commit/5a11a682e94eaa5518ee9dec508fab4614214636))
* close phase 11 — v0.11.0 released, release timings and lessons ([a41b78d](https://github.com/sanchezign/smartops-agent/commit/a41b78d726a7f4b0b58d52e722f6e0ff566c129c))
* close phase 13 — i18n, English docs and portfolio (phase 13 M9) ([f3b497d](https://github.com/sanchezign/smartops-agent/commit/f3b497d01f9272a8b688f25c594d14e0d49b10c3))
* deploy on an Oracle E2.1.Micro with a light demo profile (phase 12 M2.0) ([2b8bf9e](https://github.com/sanchezign/smartops-agent/commit/2b8bf9eafbf002b2b39e0401f77a1fe60fe110ea))
* English documentation, portfolio README and link checker (phase 13 M5) ([9c98b19](https://github.com/sanchezign/smartops-agent/commit/9c98b199d6c4b6096ebbfb7581df9db7b3b2f04f))
* panel guide for the business owner in English and Spanish (phase 13 M7) ([3412565](https://github.com/sanchezign/smartops-agent/commit/34125656ee6a3921760b5f1f059bf5a3049fb211))
* README screenshots and demo GIF, reproducible media pipeline (phase 13 M6) ([d0cdcb6](https://github.com/sanchezign/smartops-agent/commit/d0cdcb690f1f6afc0e6b6d73b32ee5d5d39d86ca))
* use the author's full name in the license ([f87ee1b](https://github.com/sanchezign/smartops-agent/commit/f87ee1bf7337bacb2d20438c5d33b70cf5532bdc))


### Tests

* **i18n:** E2E in English, Spanish smoke with axe, language switch (phase 13 M4) ([eb9b6d0](https://github.com/sanchezign/smartops-agent/commit/eb9b6d0d921654828e00ad12ed05ca9b0342fce5))

## [0.11.0](https://github.com/sanchezign/smartops-agent/compare/v0.1.0...v0.11.0) (2026-09-28)


### Bug Fixes

* **admin:** toast texts meet WCAG AA; axe waits for toast transitions ([ce72ccf](https://github.com/sanchezign/smartops-agent/commit/ce72ccf90d6c2b5d438d0ddc04c52e66a79fbf42))
* **admin:** versioned robots.txt; the image no longer assumes public/ exists ([e611034](https://github.com/sanchezign/smartops-agent/commit/e611034d6dc7a30ca35787cc9a16909007af44e4))
* **ci:** E2E web servers stop on Linux (pnpm 12 process groups) ([43e74c7](https://github.com/sanchezign/smartops-agent/commit/43e74c7c493d2c0164ff67c8b0891712ffc0f239))
* **ci:** release-please setup that survives the first release (phase 11 M5) ([09683ef](https://github.com/sanchezign/smartops-agent/commit/09683ef304a937981be8352cd03c79fd523b8e9a))


### CI/CD

* quick workflow, least-privilege tokens, workflow linting and main guard (phase 11 M1) ([b075b2e](https://github.com/sanchezign/smartops-agent/commit/b075b2e2403f5dd8874a9b835fa4d8d208900930))
* release-please and multi-arch GHCR images on release (phase 11 M5) ([4d57303](https://github.com/sanchezign/smartops-agent/commit/4d57303f09688e8384f2652772fc5686f8bb52ea))
* secret scanning, dependency audit gate, Renovate and SECURITY.md (phase 11 M3) ([bab88cb](https://github.com/sanchezign/smartops-agent/commit/bab88cb8063bd4c506aa52a78079a6fe1a646ac8))
* slow suite — Postgres service, coverage gate, build, E2E by policy, nightly (phase 11 M2) ([0c914df](https://github.com/sanchezign/smartops-agent/commit/0c914dfd6bb2bf4c1116b6535424dd23f31ced7c))


### Build

* Docker images for the API and the panel, validated in CI (phase 11 M4) ([04c4952](https://github.com/sanchezign/smartops-agent/commit/04c49525488b1261a64eff08546743c73e55e2b6))


### Documentation

* CI/CD guide, ADR-022, PR and issue templates (phase 11 M6) ([c976e9d](https://github.com/sanchezign/smartops-agent/commit/c976e9d15b95c42e8d18321ee7ba08d32bea06a1))
* **ci:** measured GitHub timings, first-run fixes and phase 11 status ([4850061](https://github.com/sanchezign/smartops-agent/commit/485006120fd04191cd97f91a1c03f86393489a3a))
* **ci:** release recovery and rebase-merge notes (phase 11 M6) ([410b623](https://github.com/sanchezign/smartops-agent/commit/410b623302cb5ec035d4dff332c99aa234ec3702))
* **ci:** Release-As must go in a commit that changes files ([668e7dd](https://github.com/sanchezign/smartops-agent/commit/668e7ddf2034269a76ba8883893d7e062c497984))


### Tests

* **api:** smaller ZIP bomb that still proves the real-size cap ([5991461](https://github.com/sanchezign/smartops-agent/commit/5991461c71969d5774166b6a882879b624ead186))

## [Before v0.11.0] — phases 1–10 (2026-09-24 → 2026-09-27)

Summary of the work before the first release (details: `CLAUDE.md`, `docs/adr/`).

- **1. Scaffold** — pnpm monorepo (`apps/api`, `apps/admin`, `n8n/workflows`, `docs/adr`),
  docker compose with Postgres (app + n8n databases) and n8n.
- **2. Config, env and logging** — Zod env (fail fast), pino-http with request id, `AppError`
  + error middleware, helmet, CORS, rate limits, `/api/v1/health`, Prisma schema and first
  migrations.
- **3. WhatsApp Cloud API** — signed webhook over the raw body, outbox + pg-boss worker,
  idempotency by message id, media download and storage, outbound messages with the 24 h
  window and opt-in, local WhatsApp simulator, anonymized real fixtures.
- **4. Media normalization** — `Transcriber` interface, Groq Whisper (free plan, ZDR) and a
  fake provider, per-contact quota.
- **5. Extraction and catalog** — `ai/` module (Claude behind a provider interface, spend
  guard, versioned prompts, Zod-validated structured output), document and spreadsheet
  conversion, catalog ingest rules, price history and human review queue.
- **6. n8n multi-agent** — receiver, processor, notifier and error workflows; deterministic
  pre-filter without AI; outbox delivery to n8n with retries; anti-spam digests.
- **7. Coexistence and opt-out** — human takeover state machine, message echoes, reply as a
  person, keyword opt-out / opt-in (no LLM).
- **8. Admin auth** — orders routed to the team, Argon2id passwords, JWT access + rotating
  refresh sessions, CSRF guard, roles, declarative panel API, minimal login.
- **9. Admin panel** — mobile-first Next.js panel (dashboard, reviews, conversations,
  real time over SSE, catalog and price charts, rules, users, digest deep links) and the
  public demo mode ("Probar el sistema") at $0.
- **10. Tests** — coverage ratchet, authorization matrix, real Postgres suites (migrations,
  triggers, workers, startup smoke), n8n contract, resilience, security, property-based
  tests, mutation testing report and a real-model prompt-injection eval.
