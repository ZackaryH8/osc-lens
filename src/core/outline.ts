import { analyze } from './analyze';
import { classify } from './classify';
import { loadLanguage } from './language';
import { tokenize } from './lexer';

export interface Sym { name: string; kind: number; range: R; selectionRange: R; detail?: string }
interface R { start: { line: number; character: number }; end: { line: number; character: number } }
const SK = { Function: 12, Event: 24, Namespace: 3 };

/** Entries ({init}/{frame}/{frame_ai}), macros and triggers, each spanning to its {end}. */
export function symbolsOf(text: string): Sym[] {
  const nodes = analyze(text).nodes;
  const out: Sym[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.kind !== 'macro-def' && n.kind !== 'trigger-def' && n.kind !== 'entry') continue;
    let end = i + 1;
    while (end < nodes.length && nodes[end].kind !== 'end' && !['macro-def', 'trigger-def', 'entry'].includes(nodes[end].kind)) end++;
    const last = nodes[Math.min(end, nodes.length - 1)];
    const start = { line: n.token.line, character: n.token.col };
    out.push({
      name: n.kind === 'entry' ? `{${n.name}}` : n.name!,
      detail: n.kind === 'macro-def' ? 'macro' : n.kind === 'trigger-def' ? 'trigger' : 'entry',
      kind: n.kind === 'macro-def' ? SK.Function : n.kind === 'trigger-def' ? SK.Event : SK.Namespace,
      range: { start, end: { line: last.token.endLine, character: last.token.endCol } },
      selectionRange: { start, end: { line: n.token.endLine, character: n.token.endCol } },
    });
  }
  return out;
}

/** Fold {macro}/{trigger}/entry … {end} and {if} … {endif}. */
export function foldingOf(text: string): { startLine: number; endLine: number }[] {
  const nodes = analyze(text).nodes;
  const out: { startLine: number; endLine: number }[] = [];
  const ifs: number[] = [];
  let block: number | undefined;
  for (const n of nodes) {
    if (n.kind === 'macro-def' || n.kind === 'trigger-def' || n.kind === 'entry') block = n.token.line;
    else if (n.kind === 'end' && block !== undefined) { if (n.token.line > block) out.push({ startLine: block, endLine: n.token.line }); block = undefined; }
    else if (n.kind === 'if') ifs.push(n.token.line);
    else if (n.kind === 'endif') { const s = ifs.pop(); if (s !== undefined && n.token.line > s) out.push({ startLine: s, endLine: n.token.line }); }
  }
  return out;
}

/** The refs key (var:/str:/const:/curve:/macro:/trig:) of the access or macro header under the cursor. */
export function refKeyAt(text: string, line: number, character: number): string | undefined {
  const language = loadLanguage();
  for (const t of tokenize(text)) {
    if (t.line !== line || character < t.col || character > t.endCol) continue;
    const n = classify(t, language);
    if (n.kind === 'macro-def') return 'macro:' + n.name!.toLowerCase();
    if (n.kind !== 'access') return undefined;
    const { x, y, name } = n as { x: string; y: string; name: string };
    if ((x === 'L' || x === 'S') && y === 'L') return 'var:' + name.toLowerCase();
    if ((x === 'L' || x === 'S') && y === '$') return 'str:' + name.toLowerCase();
    if (x === 'C') return 'const:' + name.toLowerCase();
    if (x === 'F') return 'curve:' + name.toLowerCase();
    if (x === 'M' && y === 'L') return 'macro:' + name.toLowerCase();
    if (x === 'T') return 'trig:' + name;
  }
  return undefined;
}
