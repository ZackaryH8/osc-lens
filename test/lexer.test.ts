import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tokenize, isNumber } from '../src/core/lexer';

const texts = (s: string) => tokenize(s).map((t) => t.text);

test("a line is a comment only when ' is its first character", () => {
  assert.deepEqual(texts("' whole line\n1 2\n\t' indented\n3 ' trailing"), ['1', '2', "'", 'indented', '3', "'", 'trailing']);
});

test('only space and tab split tokens: no brace or paren awareness', () => {
  assert.deepEqual(texts('{if}(L.L.x) 1'), ['{if}(L.L.x)', '1']);
  assert.deepEqual(texts('(L.L.Font_(8-1)x3)'), ['(L.L.Font_(8-1)x3)']);
});

test('quoted strings keep spaces and may span lines', () => {
  assert.deepEqual(texts('"two words" (S.$.a)'), ['"two words"', '(S.$.a)']);
  assert.deepEqual(texts('"a\nb" 1'), ['"a b"', '1']);
});

test('token positions', () => {
  const [a, b] = tokenize('  12 abc');
  assert.deepEqual([a.line, a.col, a.endCol], [0, 2, 4]);
  assert.deepEqual([b.col, b.endCol], [5, 8]);
});

test('numbers follow StrToFloat', () => {
  for (const ok of ['1', '-1', '0.5', '.5', '5.', '+2', '1e3']) assert.ok(isNumber(ok), ok);
  for (const bad of ['', '-', 'abc', '1,5', '0x10', "'"]) assert.ok(!isNumber(bad), bad);
});
