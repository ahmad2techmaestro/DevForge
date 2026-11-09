# DevForge — Service Contract (v1)

Single source of truth for the three services. If you need to change it, change it here and note the change at the bottom.

Ports: web dev `5173` · API `4000` · Agent `8000` · Redis `6379` · Mongo `27017`.

Env (shared): `INTERNAL_KEY` (shared secret for service↔service), `LLM_PROVIDER` (`anthropic|openai|mock`), `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`.

All JSON. All timestamps ISO-8601 UTC strings. IDs are strings.

---

## 1. Agent service (Python 3.12+, FastAPI, port 8000)

Auth: every route except `/health` requires header `X-Internal-Key: <INTERNAL_KEY>` (401 otherwise).
Errors: `{ "error": { "code": "string", "message": "string" } }` with a proper HTTP status.

### Health
`GET /health` → `{ status:"ok", provider:"anthropic|openai|mock", model:string, sandbox:"docker|subprocess", dockerAvailable:boolean, version:string }`

### Repository intelligence
Workspace root `WORKDIR` (default `./data`). Repos live in `WORKDIR/repos/{repoId}`.

| Route | Body / Query | Response |
|---|---|---|
| `POST /repos/index` | `{ repoId, cloneUrl?, localPath?, branch?, token? }` (exactly one of cloneUrl/localPath) | `{ repoId, commit, branch, fileCount, totalLines, languages:{[lang]:{files,lines}}, summary:string }` |
| `DELETE /repos/{repoId}` | – | `{ deleted:true }` |
| `GET /repos/{repoId}/tree` | – | `{ files:[{path,size,language,lines}] }` (ignores `.git`, `node_modules`, binaries, > 1 MB files) |
| `GET /repos/{repoId}/file?path=` | – | `{ path, content, language, lines, truncated:boolean }` |
| `POST /repos/{repoId}/search` | `{ query, limit?=20 }` | `{ results:[{path,line,snippet,score}] }` (BM25-style over chunks; no external vector DB required) |
| `POST /repos/{repoId}/explain` | `{ path, question? }` | `{ explanation:string, usage:Usage }` |
| `POST /repos/{repoId}/chat` | `{ messages:[{role:"user"|"assistant",content}] }` | `{ answer:string, citations:[{path,line}], usage:Usage }` (retrieval-grounded) |
| `GET /repos/{repoId}/health` | – | `{ score:0-100, grade:"A"|"B"|"C"|"D"|"F", metrics:{files,lines,testFiles,testRatio,todoCount,avgFileLines,largeFiles,longFunctions,secretsFound}, findings:[Finding] }` |
| `GET /repos/{repoId}/graph` | – | `{ nodes:[{id,path,language,lines,degree}], edges:[{source,target}] }` (import graph; ids = paths; cap 400 nodes by degree) |
| `POST /repos/{repoId}/bugs` | `{ paths?: string[] }` | `{ findings:[Finding], usage:Usage }` (static rules always; LLM pass when provider ≠ mock) |
| `POST /repos/{repoId}/review` | `{ diff:string }` | `{ summary:string, risk:Risk, comments:[ReviewComment], usage:Usage }` |

Types:
```
Usage        = { inputTokens:int, outputTokens:int, costUsd:number }
Finding      = { path:string, line:int, severity:"info"|"low"|"medium"|"high"|"critical", rule:string, title:string, detail:string, suggestion?:string }
Risk         = { score:0-100, level:"low"|"medium"|"high", reasons:[string] }
ReviewComment= { path:string, line:int, severity:"info"|"low"|"medium"|"high", body:string }
```

### Runs (LangGraph)
| Route | Body | Response |
|---|---|---|
| `POST /runs` | `{ runId, taskId, repoId, task:{kind:"feature"|"bugfix"|"refactor"|"tests"|"review"|"explain", title, description}, callbackUrl, options?:{autoApprove?:boolean, maxFixAttempts?:int=2} }` | `202 { runId, status:"running" }` |
| `GET /runs/{runId}` | – | `{ runId, status:"running"|"awaiting_approval"|"completed"|"failed"|"cancelled", pendingApproval?:Approval, events:[RunEvent] }` |
| `POST /runs/{runId}/approve` | `{ approvalId, decision:"approve"|"reject", feedback?:string, editedPlan?:PlanStep[] }` | `{ ok:true }` (resumes graph) |
| `POST /runs/{runId}/cancel` | – | `{ ok:true }` |
| `GET /runs/{runId}/diff` | – | `{ diff:string, files:[DiffFile] }` |
| `POST /runs/{runId}/commit` | `{ branch, message, authorName?, authorEmail? }` | `{ branch, commit, files:[DiffFile] }` (commits workspace changes to a new branch in the run's clone) |
| `POST /runs/{runId}/push` | `{ cloneUrl, branch, token }` | `{ pushed:true, branch }` |

The agent POSTs each event to `callbackUrl` (the API's `/internal/runs/{runId}/events`) with `X-Internal-Key`, body = `RunEvent`. Delivery is retried (3×, backoff). Events are also stored on disk so `GET /runs/{runId}` can resync after a restart.

```
RunEvent = { seq:int (starts 1, strictly increasing per run), type:string, ts:ISO, data:object }
PlanStep = { id:string, title:string, detail:string, files:[string] }
Approval = { approvalId:string, kind:"plan"|"changes", summary:string, payload:object }
DiffFile = { path:string, status:"added"|"modified"|"deleted", additions:int, deletions:int }
```

Event types and `data`:

| type | data |
|---|---|
| `run.started` | `{ kind, title, provider, model, sandbox }` |
| `node.started` / `node.finished` | `{ node:"classify"|"plan"|"implement"|"test"|"fix"|"review"|"pr_draft" }` |
| `log` | `{ level:"info"|"warn"|"error", message }` |
| `plan.proposed` | `{ steps:[PlanStep], summary, risk:Risk }` |
| `approval.requested` | `Approval` |
| `approval.resolved` | `{ approvalId, decision, feedback? }` |
| `tool.call` | `{ name, args }` (args truncated to 500 chars per value, secrets redacted) |
| `tool.result` | `{ name, ok:boolean, summary }` |
| `file.changed` | `{ path, additions, deletions }` |
| `diff.ready` | `{ files:[DiffFile], risk:Risk }` |
| `tests.started` | `{ command, sandbox }` |
| `tests.result` | `{ passed:int, failed:int, total:int, ok:boolean, output:string (≤ 8 KB tail), durationMs:int, sandbox, framework }` |
| `review.result` | `{ summary, risk:Risk, comments:[ReviewComment] }` |
| `usage` | `Usage` (cumulative for the run) |
| `pr.draft` | `{ title, body, branch }` |
| `run.completed` | `{ status:"completed", summary }` |
| `run.failed` | `{ error }` |
| `run.cancelled` | `{}` |

Run kinds: `review` and `explain` produce analysis only (no file changes, no changes-approval). `feature|bugfix|refactor|tests` change files.

Graph rules: plan approval is always required unless `autoApprove`; changes approval is always required before `pr.draft`; a `reject` with feedback re-enters `plan` (plan approval) or `implement` (changes approval); max 3 rejections then `run.failed`.

Sandbox: `SANDBOX=docker|subprocess|auto` (auto = docker if daemon reachable). Docker run flags: `--network none --memory 512m --cpus 1 --pids-limit 256 --read-only --tmpfs /tmp --security-opt no-new-privileges --user 1000:1000`, workspace mounted at `/workspace`. Dependency install (if needed) runs in a separate step with network. Subprocess fallback: temp copy, scrubbed env, wall-clock timeout, output cap.

---

## 2. API service (Node 22, Express, port 4000)

Auth: `Authorization: Bearer <JWT>` on `/api/*` except register/login. Internal routes use `X-Internal-Key`.
Errors: `{ "error": { "code", "message", "details?" } }`. Validation (zod) → 400 `validation_error`.
Pagination: `?limit=&cursor=` where noted → `{ items:[...], nextCursor:string|null }`.

### Auth & account
| Route | Body | Response |
|---|---|---|
| `POST /api/auth/register` | `{ email, password(≥8), name }` | `{ token, user:User }` |
| `POST /api/auth/login` | `{ email, password }` | `{ token, user:User }` |
| `GET /api/me` | – | `{ user:User, github:{connected:boolean, login?, avatarUrl?}, agent:{provider,model,sandbox,dockerAvailable,reachable:boolean} }` |
| `POST /api/github/connect` | `{ token }` | `{ login, avatarUrl }` (validated against GitHub `GET /user`; stored encrypted) |
| `DELETE /api/github/connect` | – | `{ ok:true }` |
| `GET /api/github/repos?query=` | – | `{ items:[{fullName,private,defaultBranch,description,language,updatedAt,cloneUrl}] }` |

`User = { id, email, name, createdAt }`

### Repositories
| Route | Body | Response |
|---|---|---|
| `POST /api/repos` | `{ fullName? , cloneUrl?, localPath?, branch? }` (localPath allowed only if `ALLOW_LOCAL_REPOS=true`) | `201 Repo` (status `indexing`, indexed in background; WS event `repo.updated`) |
| `GET /api/repos` | – | `{ items:[Repo] }` |
| `GET /api/repos/:id` | – | `Repo` |
| `DELETE /api/repos/:id` | – | `{ ok:true }` |
| `POST /api/repos/:id/reindex` | – | `Repo` |
| `GET /api/repos/:id/tree` | – | agent response |
| `GET /api/repos/:id/file?path=` | – | agent response |
| `GET /api/repos/:id/graph` | – | agent response |
| `GET /api/repos/:id/health` | – | agent response (also caches `health:{score,grade}` on Repo) |
| `POST /api/repos/:id/search` | `{ query }` | agent response |
| `POST /api/repos/:id/explain` | `{ path, question? }` | agent response (usage recorded) |
| `POST /api/repos/:id/bugs` | `{ paths? }` | agent response (usage recorded) |
| `POST /api/repos/:id/chat` | `{ threadId?, message }` | `{ threadId, messages:[ChatMessage] }` (persists thread) |
| `GET /api/repos/:id/chats` | – | `{ items:[{threadId,title,updatedAt}] }` |
| `GET /api/repos/:id/chats/:threadId` | – | `{ threadId, messages:[ChatMessage] }` |

```
Repo = { id, name, fullName?, cloneUrl?, source:"github"|"url"|"local", branch, status:"indexing"|"ready"|"error", error?, commit?, stats?:{fileCount,totalLines,languages}, summary?, health?:{score,grade}, createdAt, indexedAt? }
ChatMessage = { role:"user"|"assistant", content, citations?:[{path,line}], ts }
```

### Tasks (agent runs)
| Route | Body | Response |
|---|---|---|
| `POST /api/repos/:id/tasks` | `{ kind, title, description, autoApprove? }` | `201 Task` (status `queued`) |
| `GET /api/tasks?repoId=&status=&limit=&cursor=` | – | `{ items:[Task], nextCursor }` |
| `GET /api/tasks/:id` | – | `{ task:Task, events:[RunEvent], approvals:[ApprovalRecord] }` |
| `POST /api/tasks/:id/cancel` | – | `Task` |
| `POST /api/tasks/:id/approvals/:approvalId` | `{ decision:"approve"|"reject", feedback?, editedPlan? }` | `{ task:Task, approval:ApprovalRecord }` |
| `GET /api/tasks/:id/diff` | – | agent response |
| `POST /api/tasks/:id/pr` | `{ title?, body?, draft?=true, branch? }` | `{ task:Task, pr:{url,number,branch} }` — requires task `completed` + a resolved, approved `changes` approval; commits+pushes via agent, opens PR via GitHub API; 409 otherwise |

```
Task = { id, repoId, kind, title, description, status:"queued"|"running"|"awaiting_approval"|"completed"|"failed"|"cancelled", runId, summary?, error?, usage:Usage, risk?:Risk, pr?:{url,number,branch}, autoApprove:boolean, createdAt, updatedAt, finishedAt? }
ApprovalRecord = { approvalId, taskId, kind:"plan"|"changes", status:"pending"|"approved"|"rejected", summary, payload, feedback?, createdAt, resolvedAt? }
```

### Dashboard & ops
| Route | Response |
|---|---|
| `GET /api/stats` | `{ repos:int, tasks:{total,byStatus:{[status]:int}}, successRate:number(0-1), usage:Usage, daily:[{date,tasks,costUsd}] (last 14 days), recent:[Task] (5) }` |
| `GET /api/audit?limit=&cursor=` | `{ items:[{id,action,target,meta,ts}], nextCursor }` |
| `GET /api/health` | `{ status:"ok", db:"mongo|memory", redis:boolean, agent:boolean, uptimeSec:int }` (no auth) |
| `GET /metrics` | Prometheus text (no auth): `devforge_http_requests_total{method,route,status}`, `devforge_http_request_duration_seconds`, `devforge_tasks_total{status}`, `devforge_ws_connections`, `devforge_queue_depth` |

### Platform (v2)
| Route | Response |
|---|---|
| `GET /api/repos/:id/semantic-search?q=&mode=hybrid\|keyword\|semantic&limit=` | `{ mode, embedder, results:[{path,line,endLine,snippet,score,symbol}] }` |
| `GET /api/repos/:id/symbols?path=` | `{ engine:"tree-sitter\|ast\|regex", symbols:[...] }` |
| `GET /api/repos/:id/impact?path=&symbol=` | `{ engine, direct, transitive, tests, risk }` |
| `GET /api/repos/:id/callgraph?path=` | `{ engine, nodes, edges }` |
| `GET/POST /api/repos/:id/reviews` | list / create a PR review (posted to GitHub as a COMMENT review, never approve/block) |
| `GET /api/repos/:id/ci`, `POST /api/repos/:id/ci/:runId/fix` | failing workflow runs; create a bug-fix task from the job logs (needs your approval) |
| `GET/PUT /api/budget` | `{ budgetUsd:number\|null, spentUsd, remainingUsd, monthStart }`; over the cap new tasks return 402 `budget_exceeded` |
| `GET/PUT /api/notifications`, `POST /api/notifications/test` | Slack/Discord webhook status (URLs are encrypted, never returned) and event list |
| `GET /api/eval/latest` | latest DevForge-Bench result or `{available:false}` |
| `POST /webhooks/github` | HMAC-verified. Events: `issues` (label), `pull_request` (auto review), `workflow_run` (CI auto-fix on the default branch when enabled) |
| `GET/POST /api/mcp`, `PATCH /api/mcp/:id`, `POST /api/mcp/:id/test`, `DELETE /api/mcp/:id` | MCP server registry; secrets encrypted, only `secretKeys` returned. Runs receive decrypted `mcpServers` |
| `GET /api/activity?limit=` | newest tool calls, edits, approvals and results across tasks |
| `GET /api/stats` (+) | adds `byKind` and `avgDurationSec` |
| `plan.proposed` event (+) | adds optional `requirements: string[]`, `design: string` |
| `GET /api/repos/:id/semantic-search?rerank=true` | adds `reranker: "llm"` or `"http:<model>"` when a reranker ran |
| agent: `POST /mcp/inspect` | connect to one MCP server and list its tools |
| agent: `GET /llm/check` | `{ ok, provider, model, error? }` live one-token provider check |

### Internal
`POST /internal/runs/:runId/events` (`X-Internal-Key`) body `RunEvent` → idempotent on `(runId, seq)`; persists, updates Task (`status`, `usage`, `risk`, `summary`, `error`), creates/updates `ApprovalRecord` on `approval.requested` / `approval.resolved`, publishes to Redis channel `devforge:task:{taskId}` and `devforge:user:{userId}`.

Status mapping: `run.started`→`running`; `approval.requested`→`awaiting_approval`; `approval.resolved`→`running`; `run.completed`→`completed`; `run.failed`→`failed`; `run.cancelled`→`cancelled`.

### Queue
BullMQ queue `devforge-runs`; worker POSTs `/runs` on the agent with `callbackUrl = API_PUBLIC_URL/internal/runs/{runId}/events`. Retries 2× on agent unreachable; then task `failed` with error.

### WebSocket
`ws://host:4000/ws?token=<JWT>`; server → client messages:
```
{ type:"hello", userId }
{ type:"event", taskId, event:RunEvent }
{ type:"task.updated", task:Task }
{ type:"repo.updated", repo:Repo }
{ type:"pong" }
```
client → server: `{ type:"subscribe", taskId }`, `{ type:"unsubscribe", taskId }`, `{ type:"ping" }`.
Every user automatically receives `task.updated` and `repo.updated` for their own resources; `event` messages only for subscribed tasks the user owns. Closed with code 4401 on bad token.

### Storage interface (DB_DRIVER = `mongo` | `memory`)
Collections: `users, repos, tasks, events, approvals, chats, audit`. Narrow async interface used by all code:
`insertOne(coll, doc)`, `findOne(coll, filter)`, `find(coll, filter, {sort,limit,skip})`, `updateOne(coll, filter, update, {upsert})` (`$set`,`$inc`,`$push`), `deleteMany(coll, filter)`, `count(coll, filter)`. Ids are string UUIDs set by the app (`id` field). `memory` driver uses `mingo` for Mongo query semantics. Unique indexes: `users.email`, `events(runId,seq)`, `approvals(taskId,approvalId)`.

### Security defaults
`helmet`, CORS allow-list from `CORS_ORIGINS`, rate limit (auth routes 20/min/IP, API 300/min/user), bcrypt cost 12, JWT 7d (`JWT_SECRET` required in production), GitHub tokens AES-256-GCM with `ENCRYPTION_KEY` (32-byte hex), request ids, structured logs (pino), tokens never logged.

---

## 3. Web (React 18 + Vite + TypeScript, Tailwind)

Env: `VITE_API_URL` (default `http://localhost:4000`). Vite dev proxy not required.
Must implement every API route above that a user would need; typed client in `client/src/services/api/`. WS client auto-reconnects with backoff and resubscribes.

Required screens: Auth · Dashboard · Repositories (connect from GitHub list or URL) · Repo workspace (Overview, Files, Chat, Graph, Health, Bugs, Tasks) · Task detail (live agent timeline, plan approval with editable steps, diff viewer, test results, review comments, risk badge, cost, create-PR flow) · Settings (GitHub token, agent/provider status) · Audit log · Command palette.

---

## Changelog
- v2: real providers (Gemini/Groq/OpenRouter/Ollama/OpenAI-compatible), semantic search, code intelligence, PR reviews, CI autopilot, budget, notifications, benchmark.
- v1: initial contract.
