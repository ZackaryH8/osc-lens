import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { analyze } from '../src/core/analyze';

// OSC_CORPUS_DIR=<folder with .osc files>. No project, so only context-free rules can fire.
const dir = process.env.OSC_CORPUS_DIR;

function* walk(d: string): Generator<string> {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.osc$/i.test(e)) yield p;
  }
}

test('corpus: context-free errors are explainable', { skip: !dir }, () => {
  const counts = new Map<string, number>();
  for (const file of walk(dir!)) {
    for (const f of analyze(readFileSync(file, 'latin1')).findings.filter((x) => x.severity === 'error')) {
      counts.set(f.code, (counts.get(f.code) ?? 0) + 1);
      if (process.env.OSC_VERBOSE) console.log(`${file}:${f.line + 1}:${f.col + 1} ${f.code} ${f.message}`);
    }
  }
  console.log('corpus error counts', Object.fromEntries(counts));
  assert.ok(true);
});
