// Sanity checks for data/osc-language.json. When OMX is present (it sits beside this folder),
// also verify the operator table matches ScriptCompiler.Ops so the two cannot drift silently.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = JSON.parse(readFileSync(join(root, 'data/osc-language.json'), 'utf8'));
const EVIDENCE = new Set(['ida', 'corpus', 'hyp']);
let failures = 0;
const fail = (m) => { console.error('FAIL:', m); failures++; };

for (const [section, key] of [['operators', 'token'], ['directives', 'token'], ['systemVariables', 'name'], ['callbacks', 'name']]) {
  const seen = new Set();
  for (const e of data[section]) {
    if (!EVIDENCE.has(e.evidence)) fail(`${section}/${e[key]}: bad evidence '${e.evidence}'`);
    const k = e[key].toLowerCase();
    if (seen.has(k)) fail(`${section}: duplicate ${e[key]}`);
    seen.add(k);
  }
}

JSON.parse(readFileSync(join(root, 'syntaxes/osc.tmLanguage.json'), 'utf8'));
JSON.parse(readFileSync(join(root, 'language-configuration.json'), 'utf8'));

const omx = join(root, '../OMX/src/OMX.Formats/Script/ScriptCompiler.cs');
if (existsSync(omx)) {
  const text = readFileSync(omx, 'utf8');
  const block = text.slice(text.indexOf('Dictionary<string, ScriptOp> Ops'));
  const omxOps = new Set([...block.matchAll(/\["([^"]+)"\]\s*=/g)].map((m) => m[1].toLowerCase()));
  const ours = new Set(data.operators.map((o) => o.token.toLowerCase()));
  for (const t of omxOps) if (!ours.has(t)) fail(`operator '${t}' in OMX Ops but not in osc-language.json`);
  for (const t of ours) if (!omxOps.has(t)) fail(`operator '${t}' in osc-language.json but not in OMX Ops`);
} else {
  console.warn('OMX not found beside osc-lens; skipping Ops cross-check');
}

if (failures) process.exit(1);
console.log('osc-language.json OK');
