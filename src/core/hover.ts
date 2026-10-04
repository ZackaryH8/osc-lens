import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { analyze, Analysis } from './analyze';
import { Node } from './classify';
import { Language, loadLanguage } from './language';
import { Loc, ProjectInfo, Refs } from './project';

const fileLines = (file: string): string[] => {
  try { return existsSync(file) ? readFileSync(file, 'latin1').split(/\r\n|\n|\r/) : []; } catch { return []; }
};
const lineAt = (file: string, line: number): string => (fileLines(file)[line] ?? '').trim();
const where = (file: string, line: number) => `\`${basename(file)}:${line + 1}\``;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function sites(list: Loc[], total: number, limit = 4): string {
  const rows = list.slice(0, limit).map((l) => `- ${where(l.file, l.line)} \`${lineAt(l.file, l.line).slice(0, 90)}\``);
  if (total > rows.length) rows.push(`- … and ${total - rows.length} more`);
  return rows.join('\n');
}

function usage(r: Refs | undefined, reads: string, writes?: string): string {
  if (!r) return `Not used by any of this vehicle's scripts.`;
  const files = new Set([...r.reads, ...r.writes].map((l) => basename(l.file)));
  const parts = [`${reads}: ${plural(r.readCount, 'place')}`];
  if (writes) parts.push(`${writes}: ${plural(r.writeCount, 'place')}`);
  return `${parts.join(' · ')} in ${plural(files.size, 'script')}`;
}

/** Comment lines (column-0 apostrophe) directly above a definition, as plain text. */
function commentAbove(file: string, line: number): string {
  const lines = fileLines(file);
  const out: string[] = [];
  let i = line - 1;
  if (i >= 0 && lines[i].trim() === '') i--;
  while (i >= 0 && lines[i].startsWith("'")) { out.unshift(lines[i].replace(/^'+\s*/, '').replace(/^[-#=\s]+$/, '')); i--; }
  return out.filter((l) => l.trim() !== '').join(' ').trim();
}

function macroBody(file: string, line: number, max = 8): string {
  const lines = fileLines(file);
  const body: string[] = [];
  for (let i = line + 1; i < lines.length && body.length < max; i++) {
    if (/^\s*\{end\}/.test(lines[i])) return body.join('\n');
    if (lines[i].trim() !== '' && !lines[i].startsWith("'")) body.push(lines[i].replace(/\t/g, '  '));
  }
  return body.join('\n') + '\n…';
}

export interface HoverContext { text: string; line: number; character: number; project?: ProjectInfo; language?: Language; omsiPath?: string }

export function nodeAt(analysis: Analysis, line: number, character: number): Node | undefined {
  return analysis.nodes.find((n) => n.token.line === line && character >= n.token.col && character <= n.token.endCol);
}

export function hoverFor(ctx: HoverContext): string | undefined {
  const language = ctx.language ?? loadLanguage();
  const analysis = analyze(ctx.text, { project: ctx.project, language });
  const node = nodeAt(analysis, ctx.line, ctx.character);
  if (!node) return undefined;
  const p = ctx.project;
  const tag = (e: string, src?: string) => `\n\n_evidence: ${e}_${src ? ` · \`${src}\`` : ''}`;

  switch (node.kind) {
    case 'operator': case 'stringop': {
      const op = language.operatorByToken.get(node.name!)!;
      const effect = op.pops === null ? 'string stack' : `pops ${op.pops}, pushes ${op.pushes}`;
      return `**${op.token}** — ${effect}\n\n${op.doc}${tag(op.evidence, op.source)}${op.note ? `\n\n${op.note}` : ''}`;
    }
    case 'register': {
      const n = node.name![1];
      if (node.reg === 's') return `**s${n}** stores the top of the stack in register ${n} without popping it.\n\nRegisters hold 10 values (\`s0\`–\`s9\`) and are shared by everything that runs in the same pass.`;
      // Show the nearest earlier store to the same register in this entry block.
      const idx = analysis.nodes.indexOf(node);
      for (let i = idx - 1; i >= 0; i--) {
        const k = analysis.nodes[i];
        if (k.kind === 'entry' || k.kind === 'macro-def' || k.kind === 'trigger-def') break;
        if (k.kind === 'register' && k.name === `s${n}`) {
          const src = ctx.text.split(/\r\n|\n|\r/)[k.token.line].trim();
          return `**l${n}** loads register ${n}.\n\nLast stored here (line ${k.token.line + 1}):\n\`\`\`\n${src}\n\`\`\``;
        }
      }
      return `**l${n}** loads register ${n}.\n\nNo \`s${n}\` earlier in this block, so it reads a value left by the caller or an earlier script (macros share registers).`;
    }
    case 'entry': case 'if': case 'else': case 'endif': case 'end': case 'macro-def': case 'trigger-def': {
      const key = node.kind === 'entry' ? node.name! : node.kind === 'macro-def' ? 'macro' : node.kind === 'trigger-def' ? 'trigger' : node.token.text.slice(1, -1);
      const d = language.directives.find((x) => x.token === key);
      let extra = '';
      if (node.kind === 'macro-def') {
        const callers = p?.refs.get('macro:' + node.name!.toLowerCase());
        extra = `\n\n${usage(callers, 'Called')}${callers ? '\n' + sites(callers.reads, callers.readCount) : ''}`;
      }
      if (node.kind === 'trigger-def') {
        const name = node.name!.toLowerCase();
        const have = (suffix: string) => analysis.triggers.includes(name + suffix);
        extra = `\n\n\`${name}\` runs on press; \`${name}_drag\` ${have('_drag') ? '**is**' : 'is not'} defined (held); \`${name}_off\` ${have('_off') ? '**is**' : 'is not'} defined (release).`;
      }
      return d ? `**${node.token.text}**\n\n${d.doc}${extra}${tag(d.evidence, d.source)}` : undefined;
    }
    case 'access': break;
    default: return undefined;
  }

  const { x, y, name } = node as Required<Pick<Node, 'x' | 'y' | 'name'>>;
  const lower = name.toLowerCase();
  const decl = (key: string) => p?.declarations.get(key);

  if ((x === 'L' || x === 'S') && (y === 'L' || y === '$')) {
    const kind = y === 'L' ? 'var' : 'str';
    const d = decl(`${kind}:${lower}`);
    const r = p?.refs.get(`${kind}:${lower}`);
    const builtIn = d && ctx.omsiPath && /[\\/]program[\\/]/i.test(d.file);
    const head = `**${name}** — ${y === 'L' ? 'numeric' : 'string'} variable${builtIn ? ' (built-in)' : ''}`;
    if (!p) return `${head}\n\nNo project found: this script is not listed under \`[script]\` in a .bus/.ovh/.sco nearby.`;
    const where_ = d ? `Declared in ${where(d.file, d.line)}` : `**Not declared** in any varlist${p.variablesComplete || y === '$' ? '' : ' that could be read'}.`;
    const never = d && r && r.writeCount === 0 && !builtIn ? `\n\nNo script ever writes it, so it stays 0 unless the model, sound or engine config sets it.` : '';
    const writes = r && r.writeCount > 0 ? `\n\nWritten at:\n${sites(r.writes, r.writeCount)}` : '';
    return `${head}\n\n${where_}\n\n${usage(r, 'Read', 'Written')}${never}${writes}`;
  }
  if (x === 'C') {
    const d = decl(`const:${lower}`);
    const r = p?.refs.get(`const:${lower}`);
    if (!d) return `**${name}** — constant\n\n${p ? '**Not declared** in any constfile.' : 'No project found.'}`;
    return `**${name}** = \`${d.value}\`\n\nDeclared in ${where(d.file, d.line)}\n\n${usage(r, 'Used')}\n\nThe value is copied into the script when it compiles.`;
  }
  if (x === 'F') {
    const d = decl(`curve:${lower}`);
    const r = p?.refs.get(`curve:${lower}`);
    if (!d?.points) return `**${name}** — curve\n\n${p ? '**Not declared** in any constfile; OMSI aborts compiling the scripts on this.' : 'No project found.'}`;
    const xs = d.points.map((q) => q[0]); const ys = d.points.map((q) => q[1]);
    const range = d.points.length ? `x ${Math.min(...xs)} … ${Math.max(...xs)} → y ${Math.min(...ys)} … ${Math.max(...ys)}` : 'no points';
    return `**${name}** — curve, ${plural(d.points.length, 'point')}\n\n${range}\n\n${d.points.slice(0, 8).map(([a, b]) => `(${a}, ${b})`).join(' · ')}${d.points.length > 8 ? ' …' : ''}\n\nDeclared in ${where(d.file, d.line)}\n\n${usage(r, 'Used')}\n\nInput is clamped to the curve's x range.`;
  }
  if (x === 'M' && y === 'L') {
    const here = analysis.nodes.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === 'macro-def' && n.name!.toLowerCase() === lower).pop();
    const d = p?.macroDecls.get(lower);
    const r = p?.refs.get(`macro:${lower}`);
    const file = here ? undefined : d?.file;
    const line = here ? here.n.token.line : d?.line;
    let body = ''; let doc = '';
    if (here) {
      const lines = ctx.text.split(/\r\n|\n|\r/);
      const out: string[] = [];
      for (let i = here.n.token.line + 1; i < lines.length && out.length < 8; i++) { if (/^\s*\{end\}/.test(lines[i])) break; if (lines[i].trim() && !lines[i].startsWith("'")) out.push(lines[i].replace(/\t/g, '  ')); }
      body = out.join('\n');
    } else if (d) { body = macroBody(d.file, d.line); doc = commentAbove(d.file, d.line); }
    if (here && p) doc = '';
    if (line === undefined) return `**${name}** — macro\n\nNot defined in this file${p ? ' or any of the vehicle\'s scripts' : ''}.`;
    const order = here && here.i < analysis.nodes.indexOf(node) ? '\n\n⚠ Defined **before** this call; OMSI only resolves calls to macros defined later in the text.' : '';
    return `**${name}** — macro, ${file ? 'defined in ' + where(file, line) : 'defined in this file (line ' + (line + 1) + ')'}${doc ? `\n\n_${doc}_` : ''}\n\n\`\`\`\n${body}\n\`\`\`\n${usage(r, 'Called')}${order}`;
  }
  if (x === 'T') {
    const d = p ? [...p.soundTriggers].find(([k]) => k === name)?.[1] : undefined;
    const r = p?.refs.get(`trig:${name}`);
    if (d) return `**${name}** — sound trigger\n\nPlays \`${d.wav ?? '(file chosen by the script)'}\` · listed at ${where(d.file, d.line)}\n\n${usage(r, 'Fired')}\n\nTrigger names are matched exactly, including case.`;
    const near = p ? [...p.soundTriggers.keys()].find((k) => k.toLowerCase() === lower) : undefined;
    return `**${name}** — sound trigger\n\n${near ? `⚠ The sound cfg has \`${near}\`; names are case-sensitive, so this never plays.` : p?.soundRead ? 'No `[trigger]` with this name in the vehicle\'s sound cfg.' : 'The vehicle\'s sound cfg could not be read.'}\n\n${usage(r, 'Fired')}`;
  }
  if (x === 'M' && y === 'V') {
    const info = language.callbacks.find((c) => c.name.toLowerCase() === lower);
    return info ? `**${info.name}** — engine callback (${info.group})${tag(info.evidence, info.source)}${info.note ? `\n\n${info.note}` : ''}` : `**${name}** — engine callback\n\nNot in the known callback list (the list is incomplete).`;
  }
  if (y === 'S') {
    const info = language.systemVariables.find((v) => v.name.toLowerCase() === lower);
    return `**${name}** — system variable${info ? tag(info.evidence, info.source) : '\n\nNot in the known system variable list.'}`;
  }
  return undefined;
}
