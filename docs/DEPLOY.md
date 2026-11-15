# Deploying DevForge (Render + Vercel or Netlify)

Three things run on the internet: the **web client** (Vercel or Netlify), the **API** (Render) and the **agent** (Render). The API cannot do anything without the agent. If Settings shows *Agent runtime: Unreachable*, or a repository shows *Indexing failed: Agent service returned 502*, the agent service is missing or `AGENT_URL` is wrong.

You also need a **MongoDB Atlas** database and a **Redis** instance (Render: New, Key Value, Free).

## 1. Secrets you generate once

Make these on your own computer and paste them only into the hosting dashboards.

| Name | How |
|---|---|
| `INTERNAL_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. The **same** value goes on the API and the agent. |
| `JWT_SECRET` | any random string of 32 or more characters |
| `ENCRYPTION_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` (exactly 64 hex characters) |

## 2. Agent service (Render)

New, Web Service, connect this repository, then:

| Setting | Value |
|---|---|
| Name | `devforge-agent` |
| Language | Docker |
| Dockerfile Path | `ai-service/Dockerfile` |
| Docker Build Context Directory | `ai-service` |
| Health Check Path | `/health` |
| Instance type | Free (512 MB) is enough for a demo |

Environment variables:

| Name | Value |
|---|---|
| `INTERNAL_KEY` | the value from step 1 |
| `LLM_PROVIDER` | `gemini` (or `groq`, `openrouter`, ...) |
| `GEMINI_API_KEY` | your key (use the key of the provider you chose) |
| `GEMINI_MODEL` | optional, leave empty for the default |
| `SANDBOX` | `subprocess` (Render has no Docker; code runs **without isolation**, so use this only for a private demo) |
| `WORKDIR` | `/tmp/devforge` |
| `MAX_INDEX_FILES` | `3000` |
| `MAX_INDEX_MB` | `40` |

After it deploys, copy the address shown at the top of its page (it looks like `https://devforge-agent-ab12.onrender.com`), open it with `/health` added, and check it shows `{"status":"ok", ...}`. You need this exact address in step 3.

## 3. API service (Render)

You already have `devforge-api`. Its environment variables must be:

| Name | Value |
|---|---|
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `DB_DRIVER` | `mongo` |
| `MONGO_URL` | your Atlas connection string |
| `REDIS_URL` | the **Internal** URL of your Render Key Value instance |
| `AGENT_URL` | the **exact** address shown at the top of the agent service's page in Render. Render often adds letters to the name (for example `https://devforge-agent-ab12.onrender.com`), so do not type it from memory. No trailing path. |
| `INTERNAL_KEY` | the **same** value as on the agent |
| `JWT_SECRET` | from step 1 |
| `ENCRYPTION_KEY` | from step 1 |
| `WEB_ORIGIN` | your site, for example `https://devforget.vercel.app` |
| `CORS_ORIGINS` | your site, comma separated. `*` works as a wildcard, for example `https://devforget.vercel.app,https://devforget-*.vercel.app` |
| `ALLOW_LOCAL_REPOS` | `false` |
| `AGENT_TIMEOUT_MS` | `90000` (the free agent sleeps when idle and needs a minute to wake) |

`API_PUBLIC_URL` is filled in automatically from Render's own address. Set it only if you use a custom domain.

## 4. Web client

Vercel or Netlify, root directory `client`, with one environment variable:

| Name | Value |
|---|---|
| `VITE_API_URL` | the exact API address shown on the API service's page in Render |

This is a build-time variable. After changing it, redeploy the client.

## Names that differ from `.env.example`

`.env.example` is written for `docker compose`, which renames some variables. On Render use the real names:

| `.env.example` / compose | Render |
|---|---|
| `PUBLIC_API_URL` | `API_PUBLIC_URL` (automatic on Render) and `OAUTH_REDIRECT_BASE` |
| `WEB_ORIGIN` | `WEB_ORIGIN` and `CORS_ORIGINS` |
| agent address (set by compose) | `AGENT_URL` on the API |
| Mongo and Redis (set by compose) | `MONGO_URL` and `REDIS_URL` |
| `SANDBOX=docker` | `SANDBOX=subprocess` |

## If Settings says the agent is unreachable

| Message | Cause |
|---|---|
| `returned 404 (host)... That address is not the agent` | `AGENT_URL` points to an address that does not exist. Copy the real one from the agent's page. |
| `returned 502 (host)` | The agent is stopped, still starting, or crashed. Open its Logs. |
| `is unreachable (host)` | The address cannot be reached at all, or has a typo. |
| `timed out (host)` | The free agent is waking up. Wait a minute and refresh. |

The API log also prints `agent service reachable` or `agent service NOT reachable` right after it starts.

## Checking it works

1. `https://<agent>/health` shows `status: ok`.
2. `https://<api>/api/health` shows `ok`.
3. In the app, Settings shows the agent as reachable with your provider and model.
4. Connect a small public repository (Clone URL tab). It should reach *Ready*.

Free instances sleep after 15 minutes. The first request afterwards can take about a minute, so a 502 right after a pause usually clears if you wait and refresh.
