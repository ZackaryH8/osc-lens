import type { Finding } from './analyze';

export interface ConstEntry { name: string; value: number; line: number }
export interface CurveEntry { name: string; line: number; points: [number, number][] }
export interface ConstFileData { consts: ConstEntry[]; curves: CurveEntry[]; strayPoints: number[]; bad: { line: number; message: string }[] }

const TAG = /^\[(const|newcurve|pnt)\]$/i;
const NUM = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Tolerant reading of a [constfile]: tag line, then values on the following non-empty lines. */
export function parseConstText(text: string): ConstFileData {
  const raw = text.split(/\r\n|\n|\r/);
  const data: ConstFileData = { consts: [], curves: [], strayPoints: [], bad: [] };
  const next = (from: number): number => { let k = from; while (k < raw.length && raw[k].trim() === '') k++; return k; };
  let i = 0;
  while (i < raw.length) {
    const m = TAG.exec(raw[i].trim());
    if (!m) { i++; continue; }
    const kind = m[1].toLowerCase();
    if (kind === 'const') {
      const a = next(i + 1);
      const b = next(a + 1);
      const name = raw[a]?.trim() ?? '';
      const value = (raw[b] ?? '').trim();
      if (!NUM.test(value)) data.bad.push({ line: b < raw.length ? b : i, message: `[const] '${name}' needs a numeric value, got '${value}'.` });
      else data.consts.push({ name, value: parseFloat(value), line: a });
      i = b + 1;
    } else if (kind === 'newcurve') {
      const a = next(i + 1);
      data.curves.push({ name: raw[a]?.trim() ?? '', line: a, points: [] });
      i = a + 1;
    } else {
      const a = next(i + 1);
      const parts = (raw[a] ?? '').trim().split(/\s+/).filter(Boolean);
      let x: string | undefined; let y: string | undefined; let end = a;
      if (parts.length >= 2) { [x, y] = parts; } else { x = parts[0]; end = next(a + 1); y = (raw[end] ?? '').trim(); }
      if (x === undefined || !NUM.test(x) || y === undefined || !NUM.test(y)) data.bad.push({ line: a < raw.length ? a : i, message: `[pnt] needs two numbers (x y).` });
      else if (data.curves.length === 0) data.strayPoints.push(i);
      else data.curves[data.curves.length - 1].points.push([parseFloat(x), parseFloat(y)]);
      i = end + 1;
    }
  }
  return data;
}

const span = (line: number, length: number) => ({ line, col: 0, endLine: line, endCol: Math.max(length, 1) });

export function analyzeConstfile(text: string): Finding[] {
  const lines = text.split(/\r\n|\n|\r/);
  const data = parseConstText(text);
  const out: Finding[] = [];
  const at = (line: number, code: string, severity: Finding['severity'], evidence: Finding['evidence'], message: string) =>
    out.push({ code, message, severity, evidence, ...span(line, lines[line]?.length ?? 1) });
  for (const l of data.strayPoints) at(l, 'pnt-before-newcurve', 'warning', 'ida', '[pnt] before any [newcurve]: OMSI adds no point (audit SI17).');
  for (const b of data.bad) at(b.line, 'bad-value', 'error', 'corpus', b.message);
  const seen = new Map<string, number>();
  for (const c of data.consts) {
    const key = c.name.toLowerCase();
    if (seen.has(key)) at(c.line, 'dup-constant', 'warning', 'ida', `Constant '${c.name}' is already defined (line ${seen.get(key)! + 1}); OMSI uses the FIRST definition (first-match lookup, audit SI14).`);
    else seen.set(key, c.line);
  }
  const curves = new Map<string, number>();
  for (const c of data.curves) {
    const key = c.name.toLowerCase();
    if (curves.has(key)) at(c.line, 'dup-curve', 'warning', 'ida', `Curve '${c.name}' is already defined (line ${curves.get(key)! + 1}); OMSI uses the FIRST definition.`);
    else curves.set(key, c.line);
    if (c.points.length < 2) at(c.line, 'short-curve', 'info', 'corpus', `Curve '${c.name}' has ${c.points.length} point(s); a curve needs at least 2 to interpolate.`);
    for (let k = 1; k < c.points.length; k++) {
      if (c.points[k][0] <= c.points[k - 1][0]) { at(c.line, 'curve-order', 'warning', 'corpus', `Curve '${c.name}': x values should increase (point ${k + 1}: ${c.points[k][0]} after ${c.points[k - 1][0]}).`); break; }
    }
  }
  return out;
}

/** `builtIns` (lower-case) is program\varlist_roadvehicle.txt or its string counterpart, when known. */
export function analyzeVarlist(text: string, builtIns?: Set<string>): Finding[] {
  const lines = text.split(/\r\n|\n|\r/);
  const out: Finding[] = [];
  const first = new Map<string, number>();
  lines.forEach((line, i) => {
    if (line.trim() === '') return;
    const at = (code: string, severity: Finding['severity'], evidence: Finding['evidence'], message: string) =>
      out.push({ code, message, severity, evidence, ...span(i, line.length) });
    if (line !== line.trimEnd() || line !== line.trimStart()) at('padded-name', 'warning', 'hyp', 'Leading/trailing whitespace. OMSI most likely does not trim names (audit SI08, STRONG), so a script cannot match this name.');
    const name = line.trim();
    if (/\s/.test(name)) at('unusable-name', 'warning', 'ida', 'Names containing spaces cannot be written in a script: tokens split on whitespace.');
    const key = name.toLowerCase();
    if (first.has(key)) at('dup-declaration', 'warning', 'ida', `'${name}' is already declared on line ${first.get(key)! + 1}. Lookup is case-insensitive and returns the first match (audit SI09); this line still takes an index slot (SI07).`);
    else first.set(key, i);
    if (builtIns?.has(key)) at('shadows-builtin', 'info', 'ida', `'${name}' already exists in the built-in vehicle variables, which come first; this declaration is unreachable.`);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Highlighting and completion for varlists / constfiles
// ---------------------------------------------------------------------------------------------

export interface SemToken { line: number; col: number; length: number; type: 'keyword' | 'variable' | 'number' | 'function' | 'comment'; readonly?: boolean }

const tokenAt = (lines: string[], line: number, type: SemToken['type'], readonly = false): SemToken | undefined => {
  const text = lines[line];
  if (text === undefined) return undefined;
  const col = text.length - text.trimStart().length;
  const length = text.trim().length;
  return length > 0 ? { line, col, length, type, readonly } : undefined;
};

/** Mirrors parseConstText: tags are keywords, names variables/functions, values numbers, the rest prose. */
export function semanticTokensConst(text: string): SemToken[] {
  const lines = text.split(/\r\n|\n|\r/);
  const out: SemToken[] = [];
  const next = (from: number): number => { let k = from; while (k < lines.length && lines[k].trim() === '') k++; return k; };
  const push = (t: SemToken | undefined) => { if (t) out.push(t); };
  let i = 0;
  while (i < lines.length) {
    const m = TAG.exec(lines[i].trim());
    if (!m) { if (lines[i].trim() !== '') push(tokenAt(lines, i, 'comment')); i++; continue; }
    push(tokenAt(lines, i, 'keyword'));
    const kind = m[1].toLowerCase();
    if (kind === 'const') {
      const a = next(i + 1); const b = next(a + 1);
      push(tokenAt(lines, a, 'variable', true));
      push(tokenAt(lines, b, NUM.test((lines[b] ?? '').trim()) ? 'number' : 'comment'));
      i = b + 1;
    } else if (kind === 'newcurve') {
      const a = next(i + 1);
      push(tokenAt(lines, a, 'function'));
      i = a + 1;
    } else {
      const a = next(i + 1);
      const parts = (lines[a] ?? '').trim().split(/\s+/).filter(Boolean);
      if (parts.length >= 2) {
        let col = lines[a].indexOf(parts[0]);
        for (const p of parts) { out.push({ line: a, col: lines[a].indexOf(p, col), length: p.length, type: NUM.test(p) ? 'number' : 'comment' }); col = lines[a].indexOf(p, col) + p.length; }
        i = a + 1;
      } else {
        push(tokenAt(lines, a, 'number'));
        const b = next(a + 1);
        push(tokenAt(lines, b, 'number'));
        i = b + 1;
      }
    }
  }
  return out;
}

export function semanticTokensVarlist(text: string): SemToken[] {
  const lines = text.split(/\r\n|\n|\r/);
  return lines.map((_, i) => tokenAt(lines, i, 'variable')).filter((t): t is SemToken => !!t);
}

export interface DeclItem { label: string; detail: string; insertText?: string; snippet?: boolean }

const TAG_SNIPPETS: DeclItem[] = [
  { label: '[const]', detail: 'constant: name, then value', insertText: '[const]\n${1:name}\n${2:0}', snippet: true },
  { label: '[newcurve]', detail: 'curve with points', insertText: '[newcurve]\n${1:name}\n[pnt]\n${2:0}\n${3:0}\n[pnt]\n${4:1}\n${5:1}', snippet: true },
  { label: '[pnt]', detail: 'curve point: x, then y', insertText: '[pnt]\n${1:x}\n${2:y}', snippet: true },
];

export interface DeclContext {
  role: 'varlist' | 'stringvarlist' | 'constfile';
  /** names the project's scripts reference (lower-case -> first spelling) */
  used: { var: Map<string, string>; str: Map<string, string>; const: Map<string, string>; curve: Map<string, string> };
  /** names already declared anywhere in the project, lower-case */
  declared: { var: Set<string>; str: Set<string>; const: Set<string>; curve: Set<string> };
  builtIns?: Set<string>;
}

/** `lineText` is the current line up to the cursor; `text` the whole document. */
export function completeDecl(text: string, line: number, lineText: string, ctx: DeclContext): DeclItem[] {
  const lines = text.split(/\r\n|\n|\r/);
  const prefix = lineText.trim();
  if (ctx.role === 'constfile') {
    if (prefix.startsWith('[')) return TAG_SNIPPETS;
    let p = line - 1;
    while (p >= 0 && lines[p].trim() === '') p--;
    const prev = p >= 0 ? lines[p].trim().toLowerCase() : '';
    const local = parseConstText(text);
    if (prev === '[const]') return missing(ctx.used.const, ctx.declared.const, new Set(local.consts.map((c) => c.name.toLowerCase())), 'constant used in scripts, not declared yet');
    if (prev === '[newcurve]') return missing(ctx.used.curve, ctx.declared.curve, new Set(local.curves.map((c) => c.name.toLowerCase())), 'curve used in scripts, not declared yet');
    return prefix === '' ? TAG_SNIPPETS : [];
  }
  const kind = ctx.role === 'varlist' ? 'var' : 'str';
  const here = new Set(lines.map((l) => l.trim().toLowerCase()).filter(Boolean));
  return missing(ctx.used[kind], ctx.declared[kind], here, 'used in scripts, not declared yet', ctx.builtIns);
}

function missing(used: Map<string, string>, declared: Set<string>, here: Set<string>, detail: string, builtIns?: Set<string>): DeclItem[] {
  const items: DeclItem[] = [];
  for (const [lower, display] of used) {
    if (declared.has(lower) || here.has(lower) || builtIns?.has(lower)) continue;
    items.push({ label: display, detail });
  }
  return items;
}
