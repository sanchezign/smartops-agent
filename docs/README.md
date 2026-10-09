# Documentation

| Document                                                                        | What it covers                                                                      |
| ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [Panel guide](guide/panel-guide.md) · [Guía del panel](guide/guia-del-panel.md) | For the business owner and the team: every screen, in English and in Spanish        |
| [Case study](case-study.md) · [Caso de estudio](caso-de-estudio.md)             | The problem, the approach, measured results and lessons learned                     |
| [Architecture](architecture.md)                                                 | Components, the path of a message, design choices, the data model, code layout      |
| [Development](development.md)                                                   | Local setup, the WhatsApp simulator, the demo mode, scripts, environment variables  |
| [Testing](testing.md)                                                           | Test layers, coverage, mutation testing, what each suite proves                     |
| [CI/CD](ci-cd.md)                                                               | Workflows, the E2E policy, releases, supply chain, GitHub settings                  |
| [Security](security.md)                                                         | Entry points, panel sessions, data handling, secrets, the demo server, known limits |
| [Security audit 2026-10](security/audit-2026-10.md)                             | Pre-publication audit: history scan, findings, what blocks publication, fix plan    |
| [Costs](costs.md)                                                               | The $0 public demo and a monthly estimate for a real client, with sources           |
| [n8n setup](n8n-setup.md)                                                       | Importing, configuring, testing and exporting the workflows                         |
| [Coexistence guide](coexistence-client-guide.md)                                | Using one WhatsApp number from the app and from SmartOps: options for a client      |
| [Runbook](runbook.md)                                                           | Operating the demo server: deploy, rollback, backups, restore, secrets, incidents   |
| [SSH through Bastion, on demand (M3b)](deploy/bastion-access.md)                | One command when your home IP changes: allowlist, ephemeral key, tunnel, cleanup    |
| [The keep-alive load (ADR-027)](deploy/keepalive.md)                            | 20-minute trial, activation, switch-off and plan B if Oracle stops the VM           |
| [CPU calibration vs Oracle's idle policy (M7)](deploy/cpu-calibration.md)       | Reading OCI's CpuUtilization against what the VM measures itself                    |
| [Monitoring and abuse checks (M6)](deploy/monitoring.md)                        | Healthchecks.io + UptimeRobot setup, alert drills, bounded abuse / load check       |
| [Backups to Object Storage (M5)](deploy/backups.md)                             | Age key, append-only bucket, VM setup, proof and restore test                       |
| [Oracle Cloud setup (M1)](deploy/m1-oracle-setup.md)                            | Creating the $0 demo infrastructure step by step                                    |
| [Automatic VM launch retry](deploy/m1-retry-launch.md)                          | Retrying the VM creation while the region has no capacity                           |
| [Deploy bundle](../deploy/README.md)                                            | What runs on the server and how the scripts fit together                            |
| [Architecture decision records](adr/README.md)                                  | One record per significant decision (ADR-001 onward)                                |
| [Original pitch](pitch.md)                                                      | The project brief as first written, in Spanish                                      |

Project-wide: [README](../README.md), [SECURITY.md](../SECURITY.md) (reporting a
vulnerability), [CHANGELOG](../CHANGELOG.md) and [LICENSE](../LICENSE).
