import { classify, Node } from './classify';
import { Evidence, Language, loadLanguage } from './language';
import { tokenize } from './lexer';
import { ProjectInfo } from './project';

export type Severity = 'error' | 'warning' | 'info';

export interface Finding {
  code: string;
  message: string;
  severity: Severity;
  evidence: Evidence;
  line: number;
  col: number;
  endLine: number;
  endCol: number;
}

export interface AnalyzeOptions {
  project?: ProjectInfo;
  language?: Language;
  /** Experimental: stack depth checks in straight-line code right after an entry header. */
  stackAnalysis?: boolean;
}

export interface Analysis {
  findings: Finding[];
  nodes: Node[];
  macros: string[];
  triggers: string[];
}

const NODE_RULE = 'RE/omsi-2.3-script-compiler.md';

export function analyze(text: string, options: AnalyzeOptions = {}): Analysis {
  const language = options.language ?? loadLanguage();
  const project = options.project;
  const nodes = tokenize(text).map((t) => classify(t, language));
  const findings: Finding[] = [];

  const add = (node: Node, code: string, severity: Severity, evidence: Evidence, message: string) =>
    findings.push({ code, message, severity, evidence, line: node.token.line, col: node.token.col, endLine: node.token.endLine, endCol: node.token.endCol });

  // OMSI compiles from the last token to the first (sub_5D1E68): {endif} pushes, {else} needs a
  // pending {endif}, {if} pops. Leftovers are stray {endif}s; running out is undefined behaviour.
  const pending: Node[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n.kind === 'endif') pending.push(n);
    else if (n.kind === 'else' && pending.length === 0) add(n, 'unmatched-if-else', 'error', 'ida', '{else} has no {endif} after it; OMSI reads past its if-stack here (undefined behaviour).');
    else if (n.kind === 'if' && pending.length === 0) add(n, 'unmatched-if-else', 'error', 'ida', '{if} has no {endif} after it; OMSI reads past its if-stack here (undefined behaviour).');
    else if (n.kind === 'if') pending.pop();
  }
  for (const n of pending) add(n, 'stray-endif', 'warning', 'ida', 'Extra {endif}. OMSI tolerates it, but it usually marks a mistake.');

  // Macros and triggers.
  const macroDefs = new Map<string, number[]>();
  const triggerDefs = new Map<string, number[]>();
  const entries = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const put = (map: Map<string, number[]>, key: string) => map.set(key, [...(map.get(key) ?? []), i]);
    if (n.kind === 'macro-def') put(macroDefs, n.name!.toLowerCase());
    if (n.kind === 'trigger-def') put(triggerDefs, n.name!.toLowerCase());
    if (n.kind === 'entry') put(entries, n.name!);
  });
  for (const [name, at] of macroDefs) if (at.length > 1) add(nodes[at[0]], 'dup-last-wins', 'info', 'ida', `Macro '${name}' is defined ${at.length} times; the textually last definition wins.`);
  for (const [name, at] of triggerDefs) if (at.length > 1) add(nodes[at[0]], 'dup-last-wins', 'info', 'hyp', `Trigger '${name}' is defined ${at.length} times; the compiler lists later definitions first, so the last one most likely wins (runtime lookup not confirmed).`);
  for (const [name, at] of entries) if (at.length > 1) add(nodes[at[1]], 'dup-entry-first-wins', 'warning', 'hyp', `{${name}} appears ${at.length} times; the later scan overwrites, so the textually first one is used.`);

  nodes.forEach((n, i) => {
    switch (n.kind) {
      case 'unknown':
        add(n, 'unknown-word', 'error', 'ida', n.reason!);
        break;
      case 'dollar-noop':
        add(n, 'dollar-noop', 'warning', 'ida', `'${n.token.text}' is not one of the string functions; OMSI silently compiles it to nothing.`);
        break;
      case 'suspect-operator':
        add(n, 'not-an-operator', 'warning', 'hyp', `'${n.name}' is probably not an OMSI operator (the compiler has exactly 28); OMX accepts it.`);
        break;
      case 'access-noop':
        add(n, 'lowercase-access', 'warning', 'ida', `Access letters are case-sensitive and '${n.x}' is not one of L S M C T F; OMSI compiles this to nothing.`);
        break;
      case 'access':
        checkAccess(n, i);
        break;
      default:
        break;
    }
  });

  function checkAccess(n: Node, i: number): void {
    const { x, y, name } = n as Required<Pick<Node, 'x' | 'y' | 'name'>>;
    const lower = name.toLowerCase();
    if (x === 'L' || x === 'S') {
      if (y === 'L') {
        if (project && project.variablesComplete && !project.variables.has(lower)) add(n, 'undeclared-variable', 'error', 'ida', `'${name}' is not in the vehicle's numeric variable table (SC_ErrorInCommand_varinvalid; OMSI keeps going with index -1).`);
      } else if (y === '$') {
        if (project && project.stringVariablesComplete && !project.stringVariables.has(lower)) add(n, 'undeclared-variable', 'error', 'ida', `'${name}' is not in the vehicle's string variable table.`);
      } else if (y === 'S') {
        if (!language.systemVariableSet.has(lower)) add(n, 'unknown-system-variable', 'warning', 'hyp', `'${name}' is not a known system variable (list is corpus-derived and may be incomplete).`);
      }
    } else if (x === 'C') {
      if (project && !project.constants.has(lower)) add(n, 'unknown-constant', 'warning', 'ida', `Constant '${name}' is not in any [constfile] (logged by OMSI, not fatal).`);
    } else if (x === 'F' && y === 'L') {
      if (project && !project.curves.has(lower)) add(n, 'unknown-curve', 'error', 'ida', `Curve '${name}' is not in any [constfile]; OMSI raises an exception and aborts compiling the scripts.`);
    } else if (x === 'M' && y === 'L') {
      const later = (macroDefs.get(lower) ?? []).some((d) => d > i);
      const earlier = (macroDefs.get(lower) ?? []).some((d) => d < i);
      if (later || project?.laterMacros.has(lower)) return;
      if (earlier || project?.earlierMacros.has(lower)) {
        add(n, 'macro-order', 'error', 'ida', `Macro '${name}' is defined before this call. OMSI resolves a call only to macros later in the script text, so this fails (SC_ErrorInCommand_macroinvalid).`);
      } else if (project) {
        add(n, 'unknown-macro', 'error', 'ida', `No macro '${name}' in this vehicle's scripts.`);
      } else {
        add(n, 'unknown-macro', 'info', 'ida', `Macro '${name}' is not defined later in this file; it must come from a later script file.`);
      }
    } else if (x === 'M' && y === 'V') {
      const known = language.callbackSet.has(lower) || project?.callbacks?.has(lower);
      if (!known) add(n, 'unknown-callback', 'warning', 'hyp', `'${name}' is not a known engine callback (list is incomplete).`);
    }
  }

  if (project && project.missing.length > 0) {
    findings.push({ code: 'project-incomplete', severity: 'info', evidence: 'ida', line: 0, col: 0, endLine: 0, endCol: 0,
      message: `Could not read: ${project.missing.join(', ')}. Declaration checks that depend on them are turned off.` });
  }
  if (options.stackAnalysis) stackAnalysis(nodes, language, add);
  findings.sort((a, b) => a.line - b.line || a.col - b.col);
  return { findings, nodes, macros: [...macroDefs.keys()], triggers: [...triggerDefs.keys()] };
}

/**
 * Straight-line check from an entry header: depth is known to be 0 only until the first
 * construct whose stack effect is not established ({if}/{else}/{endif}, macro calls, callbacks,
 * string functions). Stores are assumed to peek (OMX behaviour, not proven).
 */
function stackAnalysis(nodes: Node[], language: Language, add: (n: Node, c: string, s: Severity, e: Evidence, m: string) => void): void {
  let depth: number | undefined;
  for (const n of nodes) {
    switch (n.kind) {
      case 'entry': case 'macro-def': case 'trigger-def': case 'end':
        depth = n.kind === 'macro-def' || n.kind === 'end' ? undefined : 0;
        continue;
      case 'if': case 'else': case 'endif': case 'stringop': case 'dollar-noop':
        depth = undefined;
        continue;
      default:
        break;
    }
    if (depth === undefined) continue;
    let pops = 0;
    let pushes = 0;
    if (n.kind === 'number' || (n.kind === 'register' && n.reg === 'l')) pushes = 1;
    else if (n.kind === 'operator') {
      const op = language.operatorByToken.get(n.name!)!;
      if (op.pops === null || op.pushes === null) { depth = undefined; continue; }
      pops = op.pops; pushes = op.pushes;
    } else if (n.kind === 'access') {
      if (n.x === 'C' || (n.x === 'L' && (n.y === 'L' || n.y === 'S'))) pushes = 1;
      else if (n.x === 'F') { pops = 1; pushes = 1; }
      else if (n.x === 'M') { depth = undefined; continue; }
    }
    if (pops > depth) {
      add(n, 'stack-underflow', 'info', 'hyp', `'${n.token.text}' needs ${pops} value(s) but only ${depth} are on the stack here; OMSI reads zeros for the missing ones.`);
      depth = 0;
    } else depth -= pops;
    depth += pushes;
    if (depth > language.stackDepth) {
      add(n, 'stack-overflow', 'info', 'hyp', `More than ${language.stackDepth} values on the stack; the oldest are dropped.`);
      depth = language.stackDepth;
    }
  }
}

export { NODE_RULE };
