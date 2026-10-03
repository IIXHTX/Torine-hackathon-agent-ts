# Torine-hackathon-agent-ts

ARC-Bench hackathon agent. TypeScript adapter layer driving **opencode** as the
coding engine (stock `opencode-ai` binary via npm - zero fork/patch). Built on
the official ARC-Bench TypeScript starter template.

## Architecture

```
platform runner → npm install (opencode binary lands via npm)
  → tsx index.ts            (adapter: task slicing, contracts, events)
    → opencode run --continue  (stock engine: reads req, writes code, skills)
```

- **Task contract sheet**: `extractTaskContract()` derives named UI targets,
  error strings, and seed values from the *current* requirement subtree at
  runtime - one agent package serves every task (stage-1/2/3, sheet) without
  hardcoded per-task strings.
- **Mechanics**: hot sessions (`--continue`), per-module audits, NUDGE turns,
  build/startup rehearsal with repair, verbatim lint (requirement quoted
  strings vs source), strict-mode final check, selftest Dockerfile output.

## Entrypoint Contract

ARC-Bench runs this agent as:

```bash
npm install            # runner installs Node deps first
tsx index.ts /path/to/requirements --output-dir /path/to/output --type web
```

ZIP root must contain `index.ts` + `package.json`.

## Layout

- `index.ts` — adapter: parses requirements.yaml, drives opencode per ROOT
  module subtree, reports SDK events, commits checkpoints, postflight checks.
- `arcbench-agent-runtime-js/` — official ARC-Bench SDK (events, traceability, git).
- `skills/` — ARC-Bench skills (opencode-native SKILL.md, mounted via config).
- `template/` — starter web app (Vite + React + TS frontend, Express + SQLite backend).
- `examples/` — model calling / SDK usage references from the official template.

## Engine

`opencode-ai` npm package (postinstall places the `opencode` binary). The
adapter writes an `opencode.json` (via `OPENCODE_CONFIG`) that maps
`OPENAI_API_KEY` / `OPENAI_BASE_URL` / `MODEL` to a bundled
`@ai-sdk/openai-compatible` provider, then runs one `opencode run` per ROOT
subtree with `--dangerously-skip-permissions`.

## Env knobs

| Var | Default | Meaning |
|---|---|---|
| `TORINE_NODE_TIMEOUT_MS` | `1200000` | per-module opencode run timeout |
| `TORINE_SMOKE` | unset | `1` = run frontend npm install + build smoke after run |

## Scoring notes (hackathon)

- Final score uses only the LAST saved submission, best run per task under it.
- Stage route: implement Stage 1 first; Stage 2/3 continue from the
  highest-scoring app of the previous stage (evolution mode: existing
  `frontend/`+`backend/` in output dir is preserved automatically).
