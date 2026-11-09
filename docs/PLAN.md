# DevForge — Plan

An AI-powered **developer tool**: connect a GitHub repository, let agents understand the codebase, then plan, implement, test, review and prepare pull requests — with a human approving every important step.

Architecture ideas are borrowed from LangChain's Open SWE (Planner → human approval → Programmer → Reviewer, isolated workspace, issue→PR flow). **No Open SWE code is copied** (its runtime is proprietary and `vendor/` is unlicensed).

## Phases

| Phase | Outcome |
|---|---|
| Explore | Open SWE studied (architecture ideas only); environment checked (no Docker daemon, no mongod → adapters) |
| Analyze | Gaps vs required stack identified (below) |
| Plan | This file + `CONTRACT.md` |
| Build | `ai-service`, `server`, `client` in parallel against the contract |
| Test | Unit tests per service + `scripts/e2e.sh` full-stack run |
| Improve | Fix integration gaps, harden security, polish UI |
| Deploy | `docker-compose.yml`, Dockerfiles, `/metrics`, health checks |

## Architecture

```
React (Vite, TS)  ──REST + WebSocket──►  Express API (Node 22)  ──HTTP──►  Agent service (Python, FastAPI)
                                          │  MongoDB (system of record)       │  LangGraph graph + SQLite checkpoints
                                          │  Redis (BullMQ queue, pub/sub)    │  Repo indexer, tools, review, health
                                          ▼                                   ▼
                                  Event fan-out to browsers          Sandbox: Docker (preferred) | subprocess (dev)
```

- **Express API** owns users, repos, tasks, approvals, events, audit, GitHub access, queue and WebSocket hub.
- **Agent service** owns everything that touches code: clone, index, analysis, LLM calls, tool loop, sandboxed test runs, diffs, commits.
- Agent → API: signed (shared key) HTTP callbacks with sequenced events. API → browsers: Redis pub/sub → WebSocket.

## LangGraph run graph

```
classify → plan → [INTERRUPT: plan approval] → implement ⇄ tools
        → test (sandbox) → (fail → fix, max N) → review
        → [INTERRUPT: changes approval] → pr_draft → done
```

Human-in-the-loop uses LangGraph `interrupt()` / `Command(resume=...)`. Rejection with feedback loops back to `plan` / `implement`.

## Gaps vs the requested stack (and how we close them)

| Requirement | Approach |
|---|---|
| MongoDB | Official driver behind a small `Store` interface; `DB_DRIVER=memory` (mingo) for tests/dev without a Mongo server |
| Redis | BullMQ job queue + pub/sub for event fan-out |
| WebSockets | `ws` server on the API, JWT auth, per-task subscriptions |
| Docker sandbox | `DockerSandbox` (no network, mem/cpu/pids limits, read-only root) with `SubprocessSandbox` fallback |
| OpenAI / Claude | `LLM_PROVIDER=anthropic|openai|mock`; mock = offline deterministic mode for CI/demo |
| GitHub API | Token-based connect, repo listing, clone, push, PR creation |
| Human approval | Plan approval + changes approval + PR approval, all persisted and auditable |

## Extra features ("tagde")

1. **Code Health score** per repo (A–F) with findings
2. **Architecture / import graph** (interactive)
3. **Risk scoring** of every diff (size, sensitive paths, deletions, missing tests)
4. **Cost & token tracker** per task and globally
5. **Task replay timeline** (every event persisted)
6. **Command palette** (Ctrl/⌘+K)
7. **Audit log** of every sensitive action
8. **Secret scanner** (blocks agent from committing credentials)
9. **Prometheus `/metrics`** on the API

## Security rules (non-negotiable)

- Agent file tools are confined to the run workspace (no path traversal, no symlink escape).
- GitHub tokens are encrypted at rest (AES-256-GCM) and never sent to the browser.
- Tokens are passed to git via an HTTP header / askpass, never stored in remote URLs on disk.
- Shell commands go through a denylist and run only inside the sandbox.
- Nothing is pushed or turned into a PR without an explicit approval event.
- Internal endpoints require `X-Internal-Key`.

## Known limitations (honest list)

- Docker sandbox code path cannot be exercised in the build environment (no daemon); it is covered by unit tests of the command construction only.
- Real Mongo is not available in the build environment; the Mongo adapter shares the same interface and is tested against the memory adapter's contract tests.
- Real LLM behaviour needs `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`; automated tests use a scripted fake model.
