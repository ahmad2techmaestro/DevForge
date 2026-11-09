# Security policy

Report vulnerabilities privately through GitHub's "Report a vulnerability" (Security tab) instead of a public issue.
Include steps to reproduce and the affected version. You will get an answer within a few days.

Design notes useful to reviewers:
- GitHub tokens are AES-256-GCM encrypted at rest, sent to git via an HTTP header (never in a URL) and never returned by the API.
- The agent service only accepts requests with `X-Internal-Key` and is not published to the host in `docker-compose.yml`.
- Agent commands run in a Docker sandbox (recommended). `SANDBOX=subprocess` is for development only and is **not isolated**.
- The agent container mounts the Docker socket to start sandboxes, which is root-equivalent on the host. Run it on a dedicated VM.
- `/webhooks/github` is disabled unless `GITHUB_WEBHOOK_SECRET` is set and verifies `X-Hub-Signature-256` over the raw body.
