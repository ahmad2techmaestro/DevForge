# Contributing

1. Fork, then create a branch: `git switch -c feat/short-description`.
2. Make the change with tests. The three suites and the e2e script must pass:
   ```bash
   (cd ai-service && .venv/bin/pytest -q && .venv/bin/ruff check .)
   (cd server  && npm test && npm run typecheck)
   (cd client        && npm test && npm run build)
   node scripts/e2e.mjs
   ```
3. Use [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `test:`).
4. Open a pull request that explains *why*, and note anything you could not test.

Security issues: please do not open a public issue. See [SECURITY.md](SECURITY.md).

Rules of the codebase: tokens are never logged or returned; every file path is confined to the repo workspace;
anything that changes code or pushes to GitHub goes through a human approval gate.
