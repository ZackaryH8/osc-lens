import raw from '../../data/osc-language.json';

export type Evidence = 'ida' | 'corpus' | 'hyp';

export interface OperatorInfo { token: string; pops: number | null; pushes: number | null; doc: string; evidence: Evidence; source: string; note?: string }
export interface DirectiveInfo { token: string; arg?: boolean; doc: string; evidence: Evidence; source: string }
export interface AccessKind { kind: string; scope: string; doc: string; evidence: Evidence }
export interface NamedInfo { name: string; group?: string; evidence: Evidence; source: string; note?: string }
export interface RuleInfo { id: string; doc: string; severity: string; evidence: Evidence; source: string }

export interface LanguageData {
  operators: OperatorInfo[];
  directives: DirectiveInfo[];
  accessKinds: AccessKind[];
  systemVariables: NamedInfo[];
  callbacks: NamedInfo[];
  compilerRules: RuleInfo[];
  stackDepth: number;
}

export interface Language extends LanguageData {
  /** Case-sensitive, as OMSI compares them (RE/omsi-2.3-script-compiler.md). */
  operatorByToken: Map<string, OperatorInfo>;
  /** Tokens the exe does not compile as operators but OMX does. */
  suspectOperators: Set<string>;
  stringOps: Set<string>;
  systemVariableSet: Set<string>;
  callbackSet: Set<string>;
}

let cached: Language | undefined;

export function loadLanguage(): Language {
  if (cached) return cached;
  const data = raw as unknown as LanguageData;
  const operatorByToken = new Map<string, OperatorInfo>();
  const suspectOperators = new Set<string>();
  const stringOps = new Set<string>();
  for (const op of data.operators) {
    if (op.token.startsWith('$')) {
      // $=> is accepted by OMX only; the exe compiles it to nothing.
      if (op.token !== '$=>') stringOps.add(op.token);
      operatorByToken.set(op.token, op);
    } else if (op.evidence === 'hyp' && op.note?.startsWith('Probably NOT')) {
      suspectOperators.add(op.token);
    } else {
      operatorByToken.set(op.token, op);
    }
  }
  const language: Language = {
    ...data,
    operatorByToken,
    suspectOperators,
    stringOps,
    systemVariableSet: new Set(data.systemVariables.map((v) => v.name.toLowerCase())),
    callbackSet: new Set(data.callbacks.map((c) => c.name.toLowerCase())),
  };
  cached = language;
  return language;
}
