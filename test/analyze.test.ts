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

test('paths in .bus files resolve case-insensitively (Windows content on Linux)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  mkdirSync(join(dir, 'script'));
  mkdirSync(join(dir, 'Program'));
  writeFileSync(join(dir, 'Program', 'varlist_roadvehicle.txt'), 'elec_busbar_main\n');
  writeFileSync(join(dir, 'Program', 'stringvarlist_roadvehicle.txt'), 'ident\n');
  writeFileSync(join(dir, 'v.bus'), '[script]\n1\nScript\\Main.OSC\n[varnamelist]\n1\nSCRIPT\\Vars.TXT\n');
  writeFileSync(join(dir, 'script', 'main.osc'), '1 (S.L.door_0)');
  writeFileSync(join(dir, 'script', 'vars.txt'), 'door_0\n');
  const project = loadProject(join(dir, 'script', 'main.osc'), dir);
  assert.ok(project);
  assert.deepEqual(project.missing, []);
  assert.deepEqual(codes('{macro:a} (L.L.door_0) (L.L.ELEC_BUSBAR_MAIN) (L.L.bogus) {end}', { project }), ['undeclared-variable']);
});

test('an unreadable varlist turns undeclared-variable checks off and says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  mkdirSync(join(dir, 'program'));
  writeFileSync(join(dir, 'program', 'varlist_roadvehicle.txt'), 'a\n');
  writeFileSync(join(dir, 'v.bus'), '[script]\n1\nm.osc\n[varnamelist]\n1\nnowhere.txt\n');
  writeFileSync(join(dir, 'm.osc'), '1 (S.L.x)');
  const project = loadProject(join(dir, 'm.osc'), dir)!;
  assert.deepEqual(codes('{macro:a} (L.L.whatever) {end}', { project }), ['project-incomplete']);
});

import { analyzeConstfile, analyzeVarlist, parseConstText } from '../src/core/declfiles';
import { complete } from '../src/core/completion';
import { loadLanguage } from '../src/core/language';
import { findRole } from '../src/core/project';

const fc = (list: { code: string }[]) => list.map((f) => f.code);

test('varlist checks', () => {
  assert.deepEqual(fc(analyzeVarlist('a\n\nb\nA\nc d\ne \n', new Set(['b']))), ['shadows-builtin', 'dup-declaration', 'unusable-name', 'padded-name']);
  assert.deepEqual(fc(analyzeVarlist('')), []);
});

test('constfile checks and tolerant parsing', () => {
  assert.deepEqual(fc(analyzeConstfile('')), []);
  const text = '[pnt]\n1\n2\n[const]\nK\n1\n[const]\nk\n2\n[newcurve]\nc\n[pnt]\n0 0\n[pnt]\n5\n6\n[pnt]\n3 3\n[const]\nbad\nxyz\n';
  assert.deepEqual(fc(analyzeConstfile(text)), ['pnt-before-newcurve', 'bad-value', 'dup-constant', 'curve-order']);
  assert.deepEqual(parseConstText(text).curves[0].points, [[0, 0], [5, 6], [3, 3]]);
});

test('constants and curves: first definition wins and values are indexed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  writeFileSync(join(dir, 'v.bus'), '[script]\n1\nm.osc\n[constfile]\n1\nc.txt\n');
  writeFileSync(join(dir, 'c.txt'), '[const]\nK\n1\n[const]\nK\n2\n');
  writeFileSync(join(dir, 'm.osc'), '1');
  const project = loadProject(join(dir, 'm.osc'))!;
  assert.equal(project.declarations.get('const:k')?.value, 1);
});

test('files are recognised by what the .bus references, whatever they are called', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  writeFileSync(join(dir, 'v.bus'), '[script]\n1\nm.osc\n[varnamelist]\n1\nMy_Vars.TXT\n[stringvarnamelist]\n1\nstr.cfg\n[constfile]\n1\nconsts.txt\n');
  for (const f of ['m.osc', 'my_vars.txt', 'str.cfg', 'consts.txt', 'other.txt']) writeFileSync(join(dir, f), '');
  assert.equal(findRole(join(dir, 'my_vars.txt'))?.role, 'varlist');
  assert.equal(findRole(join(dir, 'str.cfg'))?.role, 'stringvarlist');
  assert.equal(findRole(join(dir, 'consts.txt'))?.role, 'constfile');
  assert.equal(findRole(join(dir, 'other.txt')), undefined);
});

test('(T.L.) completes SOUND triggers, not {trigger:} blocks, and checks case', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  mkdirSync(join(dir, 'sound'));
  writeFileSync(join(dir, 'v.bus'), '[script]\n1\nm.osc\n[sound]\nsound\\sound.cfg\n');
  writeFileSync(join(dir, 'sound', 'sound.cfg'), '[sound]\nhorn.wav\n[trigger]\nev_hupe_an\n');
  writeFileSync(join(dir, 'm.osc'), '{trigger:horn} (T.L.ev_used_only) {end}');
  const project = loadProject(join(dir, 'm.osc'))!;
  assert.ok(project.soundRead);
  const labels = complete('(T.L.', { language: loadLanguage(), project, macros: [], triggers: ['horn'] }).map((i) => i.label);
  assert.ok(labels.includes('(T.L.ev_hupe_an)') && labels.includes('(T.L.ev_used_only)') && labels.includes('(T.L.ev_AI_Horn)'));
  assert.ok(!labels.includes('(T.L.horn)'));
  assert.deepEqual(codes('{macro:a} (T.L.ev_hupe_an) (T.L.EV_HUPE_AN) (T.L.nope) {end}', { project }), ['trigger-case', 'unknown-sound-trigger']);
});

import { completeDecl, semanticTokensConst, semanticTokensVarlist } from '../src/core/declfiles';
import { loadOwnerProject } from '../src/core/project';

test('constfile semantic tokens: tags, names, values, curves, prose', () => {
  const text = 'Some prose\n[const]\nK\n1.5\n[newcurve]\nc\n[pnt]\n0 1\n[pnt]\n2\n3\n';
  const t = semanticTokensConst(text).map((x) => `${x.line}:${x.type}${x.readonly ? '!' : ''}`);
  assert.deepEqual(t, ['0:comment', '1:keyword', '2:variable!', '3:number', '4:keyword', '5:function', '6:keyword', '7:number', '7:number', '8:keyword', '9:number', '10:number']);
  assert.deepEqual(semanticTokensVarlist('a\n\nb ').map((x) => [x.line, x.length]), [[0, 1], [2, 1]]);
});

test('declaration files suggest names scripts use but nothing declares', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  writeFileSync(join(dir, 'v.bus'), '[script]\n1\nm.osc\n[varnamelist]\n1\nv.txt\n[constfile]\n1\nc.txt\n');
  writeFileSync(join(dir, 'm.osc'), '(L.L.known) (L.L.NewVar) (C.L.Declared) (C.L.NewConst) (F.L.NewCurve) (L.L.elec_busbar_main)');
  writeFileSync(join(dir, 'v.txt'), 'known\n');
  writeFileSync(join(dir, 'c.txt'), '[const]\nDeclared\n1\n');
  const p = loadOwnerProject(join(dir, 'v.bus'));
  const declared = { var: p.variables, str: p.stringVariables, const: p.constants, curve: p.curves };
  const labels = (role: 'varlist' | 'constfile', text: string, line: number, builtIns?: Set<string>) =>
    completeDecl(text, line, '', { role, used: p.used, declared, builtIns }).map((i) => i.label);
  assert.deepEqual(labels('varlist', '', 0, new Set(['elec_busbar_main'])), ['NewVar']);
  assert.deepEqual(labels('constfile', '[const]\n', 1), ['NewConst']);
  assert.deepEqual(labels('constfile', '[newcurve]\n', 1), ['NewCurve']);
  assert.ok(labels('constfile', '[const]\nX\n1\n', 3).includes('[pnt]'));
});

test('declaration index covers built-ins, macros across scripts and sound triggers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  mkdirSync(join(dir, 'program')); mkdirSync(join(dir, 'veh', 'sound'), { recursive: true });
  writeFileSync(join(dir, 'program', 'varlist_roadvehicle.txt'), 'elec_busbar_main\n');
  writeFileSync(join(dir, 'program', 'stringvarlist_roadvehicle.txt'), 'ident\n');
  writeFileSync(join(dir, 'veh', 'v.bus'), '[script]\n2\na.osc\nb.osc\n[sound]\nsound\\s.cfg\n');
  writeFileSync(join(dir, 'veh', 'a.osc'), '{macro:one} {end}');
  writeFileSync(join(dir, 'veh', 'b.osc'), '{macro:two} {end}');
  writeFileSync(join(dir, 'veh', 'sound', 's.cfg'), '[trigger]\nev_a\n');
  const p = loadProject(join(dir, 'veh', 'a.osc'), dir)!;
  assert.equal(p.declarations.get('var:elec_busbar_main')?.line, 0);
  assert.equal(p.macroDecls.get('two')?.file.endsWith('b.osc'), true);
  assert.equal(p.soundTriggers.get('ev_a')?.line, 1);
});

import { hoverFor } from '../src/core/hover';
import { foldingOf, refKeyAt, symbolsOf } from '../src/core/outline';

test('hovers report project facts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'osc-lens-'));
  mkdirSync(join(dir, 'sound'));
  writeFileSync(join(dir, 'v.bus'), '[script]\n1\nm.osc\n[varnamelist]\n1\nv.txt\n[constfile]\n1\nc.txt\n[sound]\nsound\\s.cfg\n');
  writeFileSync(join(dir, 'v.txt'), 'speed\nunwritten\n');
  writeFileSync(join(dir, 'c.txt'), '[const]\nK\n2.5\n[newcurve]\ncv\n[pnt]\n0\n1\n[pnt]\n10\n5\n');
  writeFileSync(join(dir, 'sound', 's.cfg'), '[sound]\nbeep.wav\n[trigger]\nev_beep\n');
  const text = "' Does the thing\n{macro:late} 1 {end}\n{macro:a}\n  (L.L.unwritten) 3 s2 l2 (S.L.speed) (C.L.K) (F.L.cv) (T.L.ev_beep) (T.L.EV_BEEP)\n{end}\n";
  writeFileSync(join(dir, 'm.osc'), text);
  const project = loadProject(join(dir, 'm.osc'))!;
  const at = (needle: string) => hoverFor({ text, line: text.split('\n').findIndex((l) => l.includes(needle)), character: text.split('\n').find((l) => l.includes(needle))!.indexOf(needle) + 1, project })!;
  assert.match(at('(L.L.unwritten)'), /Declared in `v.txt:2`[\s\S]*No script ever writes it/);
  assert.match(at('(S.L.speed)'), /Written at:/);
  assert.match(at('(C.L.K)'), /= `2.5`/);
  assert.match(at('(F.L.cv)'), /x 0 … 10 → y 1 … 5/);
  assert.match(at('(T.L.ev_beep)'), /Plays `beep.wav`/);
  assert.match(at('(T.L.EV_BEEP)'), /case-sensitive/);
  assert.match(at('l2'), /Last stored here \(line 4\)/);
  assert.match(at('{macro:late}'), /Called: not|Not used|Called: 0|macro/i);

  assert.deepEqual(symbolsOf(text).map((s) => s.name), ['late', 'a']);
  assert.deepEqual(foldingOf(text), [{ startLine: 2, endLine: 4 }]);
  assert.equal(refKeyAt(text, 3, text.split('\n')[3].indexOf('(L.L.unwritten)') + 2), 'var:unwritten');
  assert.equal(project.refs.get('var:speed')?.writeCount, 1);
});
