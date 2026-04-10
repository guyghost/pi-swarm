# Changelog

All notable changes to pi-swarm are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
Versioning: [Semantic Versioning](https://semver.org/)

---

## [0.1.0] — 2026-04-10

### Added

#### Extension (`extensions/openspec.ts`)
- Active agent tracking persisted in session via `pi.appendEntry`
- Agent persona injection into system prompt on each turn (`before_agent_start`)
- Footer status bar showing current agent + workflow step
- `/agent <name|status|reset|list>` — manage the active agent
- `/flow <standard|ui|tdd|review|status>` — start a multi-agent workflow
- `/flow-next` — advance to the next workflow step
- `/swarm [show|compact|theme|themes|help]` — Agent Swarm dashboard (4 themes: kimi, blueprint, minimal, hangar)
- `/skill:agent-name` interception for automatic agent tracking
- `context-log.jsonl` append-only logging for all agent transitions

#### Skills
- `orchestrator` — Strategic coordinator, plan 40%/work 10%/review 40%/compound 10%, Ralph integration
- `codegen` — FC&IS production code generator (Web/Android/iOS/Rust/KMP)
- `designer` — UI/Atomic Design decomposition from maquettes
- `tests` — TDD (Chicago + London school), testing pyramid
- `integrator` — Tidy-first merge, formatter execution, conflict resolution
- `validator` — FC&IS architecture verification (read-only)
- `review` — Final APPROVED / NEEDS_FIXES / BLOCKED verdict
- `sophos` — Independent second opinion, devil's advocate (read-only)

#### Workflows
- `standard`: orchestrator → codegen → tests → integrator → validator → review
- `ui`: orchestrator → designer → codegen → tests → integrator → validator → review
- `tdd`: tests → codegen → integrator → validator → review
- `review`: validator → review

#### Package
- Pi package manifest (`package.json`) with `pi-package` keyword
- Compatible with `pi install git:github.com/<user>/pi-swarm`
- Peer dependencies: `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`

[0.1.0]: https://github.com/guyghost/pi-swarm/releases/tag/v0.1.0
