import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyze } from '../src/core/analyze';
import { loadProject } from '../src/core/project';

const codes = (text: string, options = {}) => analyze(text, options).findings.map((f) => f.code);

test('clean script has no findings', () => {
  assert.deepEqual(codes('{macro:a}\n(L.L.x) 0 >\n{if}\n1 (S.L.y)\n{endif}\n{end}'), []);
});

test('unknown words are errors; operators are case-sensitive', () => {
  assert.deepEqual(codes('{macro:a} 1 2 Min {end}'), ['unknown-word']);
  assert.match(analyze('{macro:a} 1 2 Min {end}').findings[0].message, /did you mean 'min'/);
  assert.deepEqual(codes('{macro:a} foo {end}'), ['unknown-word']);
});

test('registers are s0-s9 / l0-l9 only', () => {
  assert.deepEqual(codes('{macro:a} 1 s0 l9 {end}'), []);
  assert.deepEqual(codes('{macro:a} 1 s15 {end}'), ['unknown-word']);
  assert.deepEqual(codes('{macro:a} 1 ln {end}'), ['unknown-word']);
});

test('$ words that are not string functions compile to nothing', () => {
  assert.deepEqual(codes('{macro:a} "a" "b" $+ $nonsense $=> {end}'), ['dollar-noop', 'dollar-noop']);
  assert.deepEqual(codes('{macro:a} "a" $CutEnd {end}'), ['dollar-noop']);
});

test('operators OMX has but the exe lacks are flagged as probable', () => {
  assert.deepEqual(codes('{macro:a} 1 cos {end}'), ['not-an-operator']);
});

test('access letters are case-sensitive', () => {
  assert.deepEqual(codes('{macro:a} (l.l.x) {end}'), ['lowercase-access']);
  assert.deepEqual(codes('{macro:a} (L.L) {end}'), ['unknown-word']);
});

test('stray {endif} warns, unmatched {if}/{else} errors', () => {
  assert.deepEqual(codes('{macro:a} 1 {if} 2 {endif} {endif} {end}'), ['stray-endif']);
  assert.deepEqual(codes('{macro:a} 1 {if} 2 {end}'), ['unmatched-if-else']);
  assert.deepEqual(codes('{macro:a} 1 {else} 2 {end}'), ['unmatched-if-else']);
});

test('a surplus {endif} in a later block pairs with an unbalanced {if} earlier (if-stack is global)', () => {
  const text = '{macro:a} 1 {if} 2 {end}\n{macro:b} {endif} {end}';
  assert.deepEqual(codes(text), []);
});

test('macro calls must precede the definition in the text', () => {
  assert.deepEqual(codes('{macro:a} (M.L.b) {end}\n{macro:b} 1 {end}'), []);
  assert.deepEqual(codes('{macro:b} 1 {end}\n{macro:a} (M.L.b) {end}'), ['macro-order']);
  assert.deepEqual(codes('{macro:a} (M.L.nowhere) {end}'), ['unknown-macro']);
});

test('duplicates and entries', () => {
  assert.deepEqual(codes('{macro:a} {end}\n{macro:A} {end}'), ['dup-last-wins']);
  assert.deepEqual(codes('{frame} {end}\n{frame} {end}'), ['dup-entry-first-wins']);
});

test('stack analysis (opt-in) finds underflow right after an entry header', () => {
  assert.deepEqual(codes('{frame} + {end}'), []);
  assert.deepEqual(codes('{frame} 1 + {end}', { stackAnalysis: true }), ['stack-underflow']);
  assert.deepEqual(codes('{frame} 1 2 + (S.L.x) {end}', { stackAnalysis: true }), []);
});

test('project resolution: varlists, constfile, macro order across script files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  mkdirSync(join(dir, 'script'));
  writeFileSync(join(dir, 'x.sco'), '[script]\n2\nscript\\first.osc\nscript\\second.osc\n[varnamelist]\n1\nvars.txt\n[constfile]\n1\nconst.txt\n');
  writeFileSync(join(dir, 'vars.txt'), 'Alpha\n\nBeta\n');
  writeFileSync(join(dir, 'const.txt'), '[const]\nK\n1.5\n[newcurve]\ncurve1\n[pnt]\n0\n0\n');
  writeFileSync(join(dir, 'script', 'first.osc'), '{macro:early} {end}\n');
  writeFileSync(join(dir, 'script', 'second.osc'), '{macro:late} {end}\n');

  const first = loadProject(join(dir, 'script', 'first.osc'));
  assert.ok(first);
  assert.equal(first.index, 0);
  assert.ok(first.variables.has('alpha') && first.variables.has('beta'));
  assert.ok(first.laterMacros.has('late'));

  const text = '{macro:m} (L.L.ALPHA) (L.L.gamma) (C.L.K) (C.L.nope) (F.L.curve1) (F.L.nocurve) (M.L.late) (M.L.late) {end}';
  assert.deepEqual(codes(text, { project: first }), ['undeclared-variable', 'unknown-constant', 'unknown-curve']);

  const second = loadProject(join(dir, 'script', 'second.osc'));
  assert.deepEqual(codes('{macro:m2} (M.L.early) {end}', { project: second }), ['macro-order']);
});

test('a missing/empty constfile does not break resolution', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  writeFileSync(join(dir, 'x.sco'), '[script]\n1\ns.osc\n[constfile]\n1\nempty.txt\n');
  writeFileSync(join(dir, 'empty.txt'), '');
  writeFileSync(join(dir, 's.osc'), '1 (S.L.v)');
  assert.ok(loadProject(join(dir, 's.osc')));
});
