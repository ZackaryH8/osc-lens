import { Language } from './language';
import { Token, isNumber } from './lexer';

export type Kind =
  | 'string' | 'stringop' | 'dollar-noop' | 'if' | 'else' | 'endif' | 'end'
  | 'entry' | 'macro-def' | 'trigger-def' | 'stackdump' | 'register'
  | 'operator' | 'suspect-operator' | 'access' | 'access-noop' | 'number' | 'unknown';

export interface Node {
  kind: Kind;
  token: Token;
  /** macro/trigger name, entry tag, access name, operator token */
  name?: string;
  /** access: first and second letter */
  x?: string;
  y?: string;
  /** register: 's' or 'l' */
  reg?: string;
  /** why the word is unknown */
  reason?: string;
}

const ENTRY = new Set(['{init}', '{frame}', '{frame_ai}']);

/** Mirrors the order of tests in sub_5D1E68 (RE/omsi-2.3-script-compiler.md section 2). */
export function classify(token: Token, language: Language): Node {
  const t = token.text;
  const node = (kind: Kind, extra: Partial<Node> = {}): Node => ({ kind, token, ...extra });

  if (t.length >= 2 && t[0] === '"' && t[t.length - 1] === '"') return node('string');
  if (t[0] === '$') return language.stringOps.has(t) ? node('stringop', { name: t }) : node('dollar-noop');
  if (t === '{if}') return node('if');
  if (t === '{else}') return node('else');
  if (t === '{endif}') return node('endif');
  if (t === '{end}') return node('end');
  if (ENTRY.has(t)) return node('entry', { name: t.slice(1, -1) });
  if (t.startsWith('{macro:') && t.endsWith('}')) return node('macro-def', { name: t.slice(7, -1) });
  if (t.startsWith('{trigger:') && t.endsWith('}')) return node('trigger-def', { name: t.slice(9, -1) });
  if (t === '%stackdump%') return node('stackdump');
  if (t.length === 2 && (t[0] === 's' || t[0] === 'l')) {
    return /[0-9]/.test(t[1])
      ? node('register', { reg: t[0], name: t })
      : node('unknown', { reason: `'${t}' is read as register ${t[0]}+StrToInt('${t[1]}') and fails (only s0-s9 / l0-l9 exist)` });
  }
  const op = language.operatorByToken.get(t);
  if (op && !t.startsWith('$')) return node('operator', { name: t });
  if (language.suspectOperators.has(t)) return node('suspect-operator', { name: t });
  if (t[0] === '(' && t[t.length - 1] === ')' && t.length >= 6 && t[2] === '.' && t[4] === '.') {
    const x = t[1];
    const y = t[3];
    const name = t.slice(5, -1);
    return 'LSMCTF'.includes(x) ? node('access', { x, y, name }) : node('access-noop', { x, y, name });
  }
  if (isNumber(t)) return node('number');
  return node('unknown', { reason: unknownReason(t, language) });
}

function unknownReason(t: string, language: Language): string {
  const lower = t.toLowerCase();
  for (const key of language.operatorByToken.keys()) {
    if (!key.startsWith('$') && key !== t && key.toLowerCase() === lower) {
      return `'${t}' is not recognised; operators are case-sensitive (did you mean '${key}'?)`;
    }
  }
  if (t[0] === '{') return `unknown directive '${t}'`;
  if (t[0] === '(') return `malformed access '${t}'; expected (X.Y.name) with single-letter X and Y`;
  return `'${t}' is not an operator, register, number, string or access; OMSI raises a conversion error here`;
}
