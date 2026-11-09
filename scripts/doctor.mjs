// `npm run doctor`: live checks of your model, embeddings, reranker, MCP and GitHub using the keys in .env.
import { existsSync } from 'node:fs';
import { dirs, spawnSync, venvBin } from './lib.mjs';

const py = existsSync(venvBin('python')) ? venvBin('python') : null;
if (!py) {
  console.error('ai-service is not set up yet. Run `npm run setup` first.');
  process.exit(1);
}
const r = spawnSync(py, ['doctor.py'], { cwd: dirs.ai, stdio: 'inherit', env: { ...process.env, MCP_ALLOW_STDIO: process.env.MCP_ALLOW_STDIO ?? 'true' } });
process.exit(r.status ?? 1);
