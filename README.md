# pi-swarm

> Multi-agent Orchestrator-Workers-Synthesizer pipeline for Pi — port of the OpenSpec multi-agent system.

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
# Via git (global)
pi install git:github.com/guyghost/pi-swarm

# Ou en local (pour développement)
pi install ./path/to/pi-swarm
```

## Agents Disponibles

| Agent | Emoji | Rôle | Invoke |
|-------|-------|------|--------|
| `orchestrator` | 🎯 | Planifie, délègue, coordonne | `/skill:orchestrator` |
| `codegen` | ⚡ | Génère code de production FC&IS | `/skill:codegen` |
| `designer` | 🎨 | Analyse UI, Atomic Design | `/skill:designer` |
| `tests` | 🧪 | TDD, tests unitaires/intégration/E2E | `/skill:tests` |
| `integrator` | 🔧 | Merge, tidy-first, formatting | `/skill:integrator` |
| `validator` | ✅ | Vérifie FC&IS (read-only) | `/skill:validator` |
| `review` | 🔍 | Verdict final APPROVED/NEEDS_FIXES/BLOCKED | `/skill:review` |
| `sophos` | 🦉 | Second avis, avocat du diable | `/skill:sophos` |

## Workflows

### Standard Workflow

```
/flow standard
```

Pipeline: `orchestrator → codegen → tests → integrator → validator → review`

### TDD Workflow

```
/flow tdd
```

Pipeline: `tests → codegen → integrator → validator → review`

### Review Workflow

```
/flow review
```

Pipeline: `validator → review`

## Commandes

### Gérer l'agent actif

```bash
/agent orchestrator    # Activer l'orchestrateur
/agent codegen         # Activer codegen
/agent status          # Voir l'état actuel
/agent list            # Lister tous les agents
/agent reset           # Désactiver l'agent courant
```

### Gérer les workflows

```bash
/flow standard         # Démarrer le workflow standard
/flow tdd              # Démarrer le workflow TDD
/flow status           # Voir l'état du workflow
/flow-next             # Avancer au prochain step
```

## Utilisation Typique

### 1. Mode Manuel (skill par skill)

```bash
# 1. Charger l'orchestrateur pour planifier
/skill:orchestrator
# → "Je veux ajouter un système de notifications push..."

# 2. Activer codegen pour implémenter
/skill:codegen
# → Implémente les modules...

# 3. Activer tests pour les tests TDD
/skill:tests
# → Crée les tests...

# 4. Intégrer
/skill:integrator
# → Merge, tidy-first, formatting...

# 5. Valider
/skill:validator
# → Rapport FC&IS...

# 6. Review final
/skill:review
# → APPROVED ✅
```

### 2. Mode Pipeline (automatique)

```bash
# Démarrer le pipeline standard
/flow standard

# Chaque agent charge son persona automatiquement
# Quand un agent a terminé, avancer :
/flow-next

# Voir la progression
/flow status
```

### 3. Second Avis

```bash
# À tout moment, demander un second avis
/skill:sophos
# → Analyse critique et alternatives...
```

## Status Bar

L'extension affiche l'agent actif dans la status bar de Pi :
```
⚡ CodeGen [standard 2/6]
```

## Context Log

Toutes les transitions d'agents sont loggées dans `context-log.jsonl` à la racine du projet :

```jsonl
{"seq":1704067200000,"timestamp":"2025-01-01T12:00:00.000Z","type":"workflow_start","agent":null,"workflow":"standard","steps":["orchestrator","codegen","tests","integrator","validator","review"]}
{"seq":1704067200001,"timestamp":"2025-01-01T12:00:00.001Z","type":"agent_switch","agent":"orchestrator","workflow":"standard","from":null,"to":"orchestrator"}
{"seq":1704067200002,"timestamp":"2025-01-01T12:00:01.000Z","type":"workflow_step","agent":"codegen","workflow":"standard","step":1,"agent":"codegen","prev":"orchestrator"}
```

## Principes Architecturaux

- **FC&IS**: Pure functions in `core/`, side effects in `shell/`
- **Tidy First** (Kent Beck): Séparer les changements structurels des comportementaux
- **Compound Engineering**: Plan 40% → Work 10% → Review 40% → Compound 10%
- **Context Logging**: Toutes les décisions dans `context-log.jsonl` (append-only)
- **Correction Loop**: Max 2 itérations par agent

## Compatibilité

- Pi `0.66.0+`
- Fonctionne avec tous les providers (Anthropic, OpenAI, Gemini...)
- Skills compatibles avec d'autres harnesses (OpenCode, Claude Code) via le format standard Agent Skills

## Structure du Package

```
pi-swarm/
├── package.json              ← Pi package manifest
├── README.md
├── extensions/
│   └── openspec.ts          ← Extension principale
└── skills/
    ├── orchestrator/SKILL.md ← Coordinateur
    ├── codegen/SKILL.md      ← Générateur de code FC&IS
    ├── designer/SKILL.md     ← Analyste UI/Atomic Design
    ├── tests/SKILL.md        ← Agent TDD
    ├── integrator/SKILL.md   ← Intégrateur/merger
    ├── validator/SKILL.md    ← Validateur FC&IS (read-only)
    ├── review/SKILL.md       ← Reviewer final
    └── sophos/SKILL.md       ← Avocat du diable
```

## Licence

MIT
