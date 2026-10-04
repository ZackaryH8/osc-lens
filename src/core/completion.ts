import { Language } from './language';
import { ProjectInfo } from './project';

export interface Item { label: string; detail?: string; documentation?: string; kind: 'operator' | 'keyword' | 'variable' | 'function' | 'constant' | 'snippet' }

const tag = (evidence: string) => `[${evidence}]`;

export interface Context { language: Language; project?: ProjectInfo; macros: string[]; triggers: string[] }

/** `prefix` is the text of the current token up to the cursor. */
export function complete(prefix: string, ctx: Context): Item[] {
  const { language, project } = ctx;
  if (prefix.startsWith('(')) {
    const parts = prefix.slice(1).split('.');
    if (parts.length === 1) {
      return [...new Set(language.accessKinds.map((k) => k.kind))].map((k) => ({
        label: `(${k}.`, kind: 'keyword', detail: kindName(k),
      }));
    }
    const x = parts[0];
    if (parts.length === 2) {
      return language.accessKinds.filter((k) => k.kind === x).map((k) => ({
        label: `(${x}.${k.scope}.`, kind: 'keyword', detail: `${k.doc} ${tag(k.evidence)}`,
      }));
    }
    const y = parts[1];
    const head = `(${x}.${y}.`;
    const name = (label: string, kind: Item['kind'], detail?: string, documentation?: string): Item => ({ label: `${head}${label})`, kind, detail, documentation });
    const set = (values: Iterable<string> | undefined, kind: Item['kind'], detail: string) => [...(values ?? [])].map((v) => name(v, kind, detail));
    if ((x === 'L' || x === 'S') && y === 'L') return set(project?.variables, 'variable', 'numeric variable');
    if ((x === 'L' || x === 'S') && y === '$') return set(project?.stringVariables, 'variable', 'string variable');
    if ((x === 'L' || x === 'S') && y === 'S') return language.systemVariables.map((v) => name(v.name, 'variable', `system variable ${tag(v.evidence)}`));
    if (x === 'C') return set(project?.constants, 'constant', 'constant');
    if (x === 'F') return set(project?.curves, 'function', 'curve');
    if (x === 'M' && y === 'L') return set(new Set([...ctx.macros, ...(project?.laterMacros ?? [])]), 'function', 'macro (must be defined later in the text)');
    if (x === 'M' && y === 'V') return language.callbacks.map((c) => name(c.name, 'function', `${c.group ?? 'callback'} ${tag(c.evidence)}`, c.note));
    if (x === 'T') return ctx.triggers.map((t) => name(t, 'function', 'trigger'));
    return [];
  }
  if (prefix.startsWith('{')) {
    return language.directives.map((d) => ({
      label: d.arg ? `{${d.token}:` : `{${d.token}}`, kind: 'keyword', detail: tag(d.evidence), documentation: d.doc,
    }));
  }
  const items: Item[] = [];
  for (const op of language.operators) {
    if (op.token.startsWith('$') !== prefix.startsWith('$') && prefix.length > 0) continue;
    if (op.note?.startsWith('Probably NOT')) continue;
    const effect = op.pops === null ? 'string stack' : `pops ${op.pops}, pushes ${op.pushes}`;
    items.push({ label: op.token, kind: 'operator', detail: `${effect} ${tag(op.evidence)}`, documentation: op.doc });
  }
  if (!prefix.startsWith('$')) {
    for (let i = 0; i <= 9; i++) {
      items.push({ label: `l${i}`, kind: 'variable', detail: 'load register (peek)' });
      items.push({ label: `s${i}`, kind: 'variable', detail: 'store register (does not pop)' });
    }
  }
  return items;
}

function kindName(k: string): string {
  return ({ L: 'load', S: 'store', C: 'constant', F: 'curve', M: 'macro / callback', T: 'trigger' } as Record<string, string>)[k] ?? k;
}
