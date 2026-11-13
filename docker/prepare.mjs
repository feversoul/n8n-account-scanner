// Used by bootstrap.sh inside the n8n container: writes the import files for
// the n8n CLI from the environment, so no secret is stored in the repository.
//   node prepare.mjs <workflows dir> <output dir>

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [source, out] = process.argv.slice(2);
const env = process.env;

const credentials = [
  { id: 'acctScannerKey', name: 'Account Scanner Key', type: 'httpHeaderAuth', data: { name: 'X-Scanner-Key', value: env.SCANNER_KEY } },
  { id: 'acctScannerModel', name: 'Account Scanner Model', type: 'openAiApi', data: { apiKey: env.MODEL_API_KEY || 'none', header: false } },
];

mkdirSync(join(out, 'workflows'), { recursive: true });
writeFileSync(join(out, 'credentials.json'), JSON.stringify(credentials));

// Settings that can come from the environment. Each is a `const NAME = value;`
// line in the Settings node.
const texts = ['MODEL_BASE_URL', 'MODEL', 'LOCATION', 'INTENT_SIGNAL'];
const numbers = ['RETRY_WAIT_SECONDS'];

for (const file of readdirSync(source).filter((name) => name.endsWith('.json'))) {
  const workflow = JSON.parse(readFileSync(join(source, file), 'utf8'));
  for (const node of workflow.nodes) {
    if (typeof node.parameters.jsCode !== 'string') continue;
    let code = node.parameters.jsCode;
    for (const name of texts) {
      if (env[name]) code = code.replace(new RegExp(`const ${name} = '[^']*';`), () => `const ${name} = ${JSON.stringify(env[name])};`);
    }
    for (const name of numbers) {
      if (Number(env[name]) > 0) code = code.replace(new RegExp(`const ${name} = [0-9.]+;`), `const ${name} = ${Number(env[name])};`);
    }
    node.parameters.jsCode = code;
  }
  writeFileSync(join(out, 'workflows', file), JSON.stringify(workflow));
}
