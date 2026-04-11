# pi-swarm

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Pi Package](https://img.shields.io/badge/pi-package-blue)](https://shittycodingagent.ai/packages)
[![Pi ≥ 0.66.0](https://img.shields.io/badge/pi-%3E%3D0.66.0-green)](https://github.com/badlogic/pi-mono)

> Multi-agent Orchestrator-Workers-Synthesizer pipeline for Pi — 8 specialized agents, 4 workflows, and a live TUI widget.

## Architecture

```
                     @orchestrator (coordinator)
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
      @designer       @codegen          @tests
      (UI/vision)     (code FC&IS)      (TDD)
           └───────────────┼───────────────┘
                           ▼
                      @integrator → @validator → @review
                                                    │
                                              @sophos (on-demand)
```

## Installation

```bash
# Global
pi install git:github.com/guyghost/pi-swarm

# Local (shared via .pi/settings.json)
pi install -l git:github.com/guyghost/pi-swarm

# Test without installing
pi -e git:github.com/guyghost/pi-swarm
```

Compatible with Pi `>= 0.66.0` and all providers (Anthropic, OpenAI, Gemini…).

## Agents

| Agent | Emoji | Role | Invoke |
|-------|-------|------|--------|
| `orchestrator` | 🎯 | Plans, delegates, coordinates | `/skill:orchestrator` |
| `codegen` | ⚡ | Generates production code (FC&IS) | `/skill:codegen` |
| `designer` | 🎨 | Analyzes UI, Atomic Design | `/skill:designer` |
| `tests` | 🧪 | TDD, unit/integration/E2E tests | `/skill:tests` |
| `integrator` | 🔧 | Merges, tidy-first, formatting | `/skill:integrator` |
| `validator` | ✅ | Verifies FC&IS (read-only) | `/skill:validator` |
| `review` | 🔍 | Final verdict: APPROVED/NEEDS_FIXES/BLOCKED | `/skill:review` |
| `sophos` | 🦉 | Second opinion, devil's advocate | `/skill:sophos` |

## Workflows

| Workflow | Pipeline | Start |
|----------|----------|-------|
| **Standard** | orchestrator → codegen → tests → integrator → validator → review | `/flow standard` |
| **UI** | orchestrator → designer → codegen → tests → integrator → validator → review | `/flow ui` |
| **TDD** | tests → codegen → integrator → validator → review | `/flow tdd` |
| **Review** | validator → review | `/flow review` |

## Commands

### Agent Management

```bash
/agent <name>       # Activate an agent
/agent status       # Current status
/agent list         # List all agents
/agent reset        # Deactivate current agent
```

### Workflow Control

```bash
/flow <workflow>    # Start a workflow
/flow status        # Show workflow status
/flow-next          # Advance to next step
/flow back          # Go back one step
/flow goto <N>      # Jump to step N
/flow skip          # Skip current step
/flow restart       # Restart from step 1
/flow retry         # Correction cycle on current agent
/flow autopersona   # Toggle auto-persona loading
```

### Swarm & Marshal

```bash
/swarm              # Compact status line
/swarm help         # Help

/marshal status     # Marshal loop status
/marshal stop       # Pause active loop
/marshal resume     # Resume paused loop
```

## Usage

### Manual (skill by skill)

```bash
/skill:orchestrator   # Plan the feature
/skill:codegen        # Implement
/skill:tests          # Write tests
/skill:integrator     # Merge and tidy
/skill:validator      # Verify architecture
/skill:review         # Final verdict
```

### Pipeline (automatic)

```bash
/flow standard        # Start the pipeline
# Each agent auto-loads its persona
# Agents call flow_complete to advance automatically
/flow status          # Check progress
```

## Key Principles

- **FC&IS**: Pure functions in `core/`, side effects in `shell/`
- **Tidy First** (Kent Beck): Separate structural from behavioral changes
- **Compound Engineering**: Plan 40% → Work 10% → Review 40% → Compound 10%
- **Context Logging**: All decisions logged to `context-log.jsonl` (append-only)
- **Correction Loop**: Max 2 iterations per agent

## Structure

```
pi-swarm/
├── package.json           # Pi package manifest
├── extensions/
│   └── swarm.ts           # Main extension
└── skills/
    ├── orchestrator/      # Coordinator
    ├── codegen/           # Code generator (FC&IS)
    ├── designer/          # UI/Atomic Design analyst
    ├── tests/             # TDD agent
    ├── integrator/        # Merger/tidier
    ├── validator/         # Architecture verifier (read-only)
    ├── review/            # Final reviewer
    └── sophos/            # Devil's advocate
```

## License

MIT
