import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tokenize } from './lexer';
import { parseConstText } from './declfiles';

export interface Decl { file: string; line: number; value?: number; points?: [number, number][]; /** sound trigger: the wav of the [sound] block it belongs to */ wav?: string }

export interface Loc { file: string; line: number; col: number; endCol: number }
export interface Refs { reads: Loc[]; writes: Loc[]; readCount: number; writeCount: number }
const CAP = 300;

export type Role = 'varlist' | 'stringvarlist' | 'constfile';

export interface ProjectInfo {
  /** Every use in the vehicle's scripts. Keys: var:/str:/const:/curve:/macro: (lower-case) and trig: (exact case). */
  refs: Map<string, Refs>;
  /** Names the scripts reference, keyed lower-case with the first spelling seen. */
  used: Used;
  /** Keys: var:<name>, str:<name>, const:<name>, curve:<name> (lower-case). First definition wins, as in OMSI. */
  declarations: Map<string, Decl>;
  /** Exact-case sound trigger names from the vehicle's sound cfg [trigger] entries. */
  soundTriggers: Map<string, Decl>;
  /** {macro:name} definitions across the vehicle's scripts; the textually last one wins, as in OMSI. */
  macroDecls: Map<string, Decl>;
  /** Names passed to (T.L.x)/(T.F.x) in the vehicle's scripts. */
  usedTriggers: Set<string>;
  soundRead: boolean;
  owner: string;
  scripts: string[];
  index: number;
  variables: Set<string>;
  stringVariables: Set<string>;
  constants: Set<string>;
  curves: Set<string>;
  earlierMacros: Set<string>;
  laterMacros: Set<string>;
  /** True when the numeric table is known in full (built-ins loaded, or not a road vehicle). */
  variablesComplete: boolean;
  stringVariablesComplete: boolean;
  callbacks?: Set<string>;
  /** Files the owner lists (or that OMSI needs) that could not be found or read. */
  missing: string[];
}

/**
 * Resolves a path case-insensitively, as OMSI (Windows) does. .bus files say `Script\\Vars.txt`
 * while the file on a case-sensitive filesystem may be `script/vars.txt`. Returns undefined when
 * some segment does not exist.
 */
export function resolveCI(base: string, relative: string): string | undefined {
  let current = resolve(base);
  for (const part of relative.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { current = dirname(current); continue; }
    let entries: string[];
    try { entries = readdirSync(current); } catch { return undefined; }
    const hit = entries.includes(part) ? part : entries.find((e) => e.toLowerCase() === part.toLowerCase());
    if (hit === undefined) return undefined;
    current = join(current, hit);
  }
  return current;
}

const read = (path: string): string => readFileSync(path, 'latin1');
const norm = (path: string): string => resolve(path).replace(/\\/g, '/').toLowerCase();

function lines(path: string): string[] {
  return read(path).split(/\r\n|\n|\r/);
}

function names(path: string | undefined): string[] {
  return path && existsSync(path) ? lines(path).map((l) => l.trim()).filter((l) => l.length > 0) : [];
}

/** Reads "[tag] / count / n paths" sections of a .bus/.ovh/.sco. */
export function parseOwner(path: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  const raw = lines(path).map((l) => l.trim());
  for (let i = 0; i < raw.length; i++) {
    const single = /^\[(sound|sound_ai)\]$/i.exec(raw[i]);
    if (single && raw[i + 1]) { (result[single[1].toLowerCase()] ??= []).push(raw[i + 1]); i += 1; continue; }
    const m = /^\[(script|varnamelist|stringvarnamelist|constfile)\]$/i.exec(raw[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const count = parseInt(raw[i + 1] ?? '', 10);
    if (!Number.isFinite(count)) continue;
    const list = (result[key] ??= []);
    for (let k = 0; k < count; k++) list.push(raw[i + 2 + k] ?? '');
    i += 1 + count;
  }
  return result;
}

function parseConst(path: string | undefined, constants: Set<string>, curves: Set<string>, decls: Map<string, Decl>): void {
  if (!path || !existsSync(path)) return;
  const data = parseConstText(read(path));
  for (const c of data.consts) {
    const k = c.name.toLowerCase();
    constants.add(k);
    if (!decls.has(`const:${k}`)) decls.set(`const:${k}`, { file: path, line: c.line, value: c.value });
  }
  for (const c of data.curves) {
    const k = c.name.toLowerCase();
    curves.add(k);
    if (!decls.has(`curve:${k}`)) decls.set(`curve:${k}`, { file: path, line: c.line, points: c.points });
  }
}

function declareNames(path: string | undefined, kind: 'var' | 'str', into: Set<string>, decls: Map<string, Decl>): void {
  if (!path || !existsSync(path)) return;
  lines(path).forEach((raw, line) => {
    const n = raw.trim();
    if (n === '') return;
    into.add(n.toLowerCase());
    if (!decls.has(`${kind}:${n.toLowerCase()}`)) decls.set(`${kind}:${n.toLowerCase()}`, { file: path, line });
  });
}

function soundTriggersOf(path: string | undefined, into: Map<string, Decl>): boolean {
  if (!path || !existsSync(path)) return false;
  const raw = lines(path).map((l) => l.trim());
  for (let i = 0; i < raw.length; i++) if (/^\[trigger\]$/i.test(raw[i]) && raw[i + 1] && !into.has(raw[i + 1])) {
      let j = i - 1;
      while (j >= 0 && !/^\[sound\]$/i.test(raw[j])) j--;
      into.set(raw[i + 1], { file: path, line: i + 1, wav: j >= 0 ? raw[j + 1] : undefined });
    }
  return true;
}

function triggerUses(path: string | undefined, into: Set<string>): void {
  if (!path || !existsSync(path)) return;
  for (const t of tokenize(read(path))) {
    const m = /^\(T\.[LF]\.(.+)\)$/.exec(t.text);
    if (m) into.add(m[1]);
  }
}

function macrosOf(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  return tokenize(read(path)).filter((t) => t.text.startsWith('{macro:') && t.text.endsWith('}')).map((t) => t.text.slice(7, -1).toLowerCase());
}

export interface Used { var: Map<string, string>; str: Map<string, string>; const: Map<string, string>; curve: Map<string, string> }

function usesOf(path: string | undefined, into: Used): void {
  if (!path || !existsSync(path)) return;
  for (const t of tokenize(read(path))) {
    const m = /^\((.)\.(.)\.(.+)\)$/.exec(t.text);
    if (!m) continue;
    const [, x, y, name] = m;
    const map = x === 'C' ? into.const : x === 'F' ? into.curve : (x === 'L' || x === 'S') && y === 'L' ? into.var : (x === 'L' || x === 'S') && y === '$' ? into.str : undefined;
    if (map && !map.has(name.toLowerCase())) map.set(name.toLowerCase(), name);
  }
}

function refsOf(path: string | undefined, into: Map<string, Refs>): void {
  if (!path || !existsSync(path)) return;
  for (const t of tokenize(read(path))) {
    const m = /^\((.)\.(.)\.(.+)\)$/.exec(t.text);
    if (!m) continue;
    const [, x, y, name] = m;
    let key: string | undefined;
    let write = false;
    if ((x === 'L' || x === 'S') && y === 'L') { key = 'var:' + name.toLowerCase(); write = x === 'S'; }
    else if ((x === 'L' || x === 'S') && y === '$') { key = 'str:' + name.toLowerCase(); write = x === 'S'; }
    else if (x === 'C') key = 'const:' + name.toLowerCase();
    else if (x === 'F') key = 'curve:' + name.toLowerCase();
    else if (x === 'M' && y === 'L') key = 'macro:' + name.toLowerCase();
    else if (x === 'T') key = 'trig:' + name;
    if (!key) continue;
    let r = into.get(key);
    if (!r) into.set(key, (r = { reads: [], writes: [], readCount: 0, writeCount: 0 }));
    const loc = { file: path, line: t.line, col: t.col, endCol: t.endCol };
    if (write) { r.writeCount++; if (r.writes.length < CAP) r.writes.push(loc); }
    else { r.readCount++; if (r.reads.length < CAP) r.reads.push(loc); }
  }
}

function buildProject(owner: string, dir: string, sections: Record<string, string[]>, index: number, omsiPath: string | undefined): ProjectInfo {
  const entry = basename(owner);
  const missing: string[] = [];
  const found = (p: string): string | undefined => {
    const hit = resolveCI(dir, p);
    if (!hit || !existsSync(hit)) missing.push(p);
    return hit;
  };
  const scripts = (sections.script ?? []).map((p) => resolveCI(dir, p) ?? resolve(dir, p.replace(/\\/g, '/')));
  const used: Used = { var: new Map(), str: new Map(), const: new Map(), curve: new Map() };
  scripts.forEach((p) => usesOf(p, used));
  const refs = new Map<string, Refs>();
  scripts.forEach((p) => refsOf(p, refs));
  const variables = new Set<string>();
  const stringVariables = new Set<string>();
  const constants = new Set<string>();
  const curves = new Set<string>();
  const declarations = new Map<string, Decl>();
  const isVehicle = /\.(bus|ovh)$/i.test(entry);
  let variablesComplete = !isVehicle;
  let stringVariablesComplete = !isVehicle;
  if (isVehicle && omsiPath) {
    const builtIn = resolveCI(omsiPath, 'program/varlist_roadvehicle.txt');
    const builtInStr = resolveCI(omsiPath, 'program/stringvarlist_roadvehicle.txt');
    if (builtIn && existsSync(builtIn)) { declareNames(builtIn, 'var', variables, declarations); variablesComplete = true; } else missing.push('program/varlist_roadvehicle.txt (under oscLens.omsiPath)');
    if (builtInStr && existsSync(builtInStr)) { declareNames(builtInStr, 'str', stringVariables, declarations); stringVariablesComplete = true; } else missing.push('program/stringvarlist_roadvehicle.txt (under oscLens.omsiPath)');
  }
  for (const p of sections.varnamelist ?? []) declareNames(found(p), 'var', variables, declarations);
  for (const p of sections.stringvarnamelist ?? []) declareNames(found(p), 'str', stringVariables, declarations);
  for (const p of sections.constfile ?? []) parseConst(found(p), constants, curves, declarations);
  const soundTriggers = new Map<string, Decl>();
  let soundRead = false;
  for (const p of [...(sections.sound ?? []), ...(sections.sound_ai ?? [])]) soundRead = soundTriggersOf(resolveCI(dir, p), soundTriggers) || soundRead;
  const usedTriggers = new Set<string>();
  scripts.forEach((p) => triggerUses(p, usedTriggers));

  const macroDecls = new Map<string, Decl>();
  for (const p of scripts) {
    if (!existsSync(p)) continue;
    for (const t of tokenize(read(p))) if (t.text.startsWith('{macro:') && t.text.endsWith('}')) macroDecls.set(t.text.slice(7, -1).toLowerCase(), { file: p, line: t.line });
  }
  const earlierMacros = new Set<string>();
  const laterMacros = new Set<string>();
  scripts.forEach((p, i) => {
    if (i === index) return;
    for (const m of macrosOf(p)) (i < index ? earlierMacros : laterMacros).add(m);
  });

  let callbacks: Set<string> | undefined;
  if (omsiPath) {
    const list = resolveCI(omsiPath, 'program/callbacklist_roadvehicle.txt');
    if (list && existsSync(list)) callbacks = new Set(names(list).map((n) => n.toLowerCase()));
  }
  // A varlist we could not read means the table is not known in full: do not guess.
  if (missing.some((m) => !m.startsWith('program/'))) { variablesComplete = false; stringVariablesComplete = false; }
  return { refs, macroDecls, used, declarations, soundTriggers, usedTriggers, soundRead, missing, owner, scripts, index, variables, stringVariables, constants, curves, earlierMacros, laterMacros, variablesComplete, stringVariablesComplete, callbacks };
}

/** Finds the .bus/.ovh/.sco that lists this script and gathers what it declares. */
export function loadProject(scriptPath: string, omsiPath?: string): ProjectInfo | undefined {
  const target = norm(scriptPath);
  let dir = dirname(resolve(scriptPath));
  for (let depth = 0; depth < 5; depth++, dir = dirname(dir)) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries.filter((e) => /\.(bus|ovh|sco)$/i.test(e))) {
      const owner = join(dir, entry);
      const sections = parseOwner(owner);
      const scripts = (sections.script ?? []).map((p) => resolveCI(dir, p) ?? resolve(dir, p.replace(/\\/g, '/')));
      const index = scripts.findIndex((p) => norm(p) === target);
      if (index >= 0) return buildProject(owner, dir, sections, index, omsiPath);
    }
  }
  return undefined;
}

/** The same project, starting from the .bus/.ovh/.sco itself (used for varlist/constfile editing). */
export function loadOwnerProject(owner: string, omsiPath?: string): ProjectInfo {
  return buildProject(owner, dirname(resolve(owner)), parseOwner(owner), -1, omsiPath);
}

export const ownerName = (p: ProjectInfo): string => basename(p.owner);

/** Which declaration role (if any) a file plays for the .bus/.ovh/.sco that references it. */
export function findRole(filePath: string): { role: Role; owner: string } | undefined {
  const target = norm(filePath);
  let dir = dirname(resolve(filePath));
  for (let depth = 0; depth < 5; depth++, dir = dirname(dir)) {
    let entries: string[] = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries.filter((e) => /\.(bus|ovh|sco)$/i.test(e))) {
      const owner = join(dir, entry);
      const sections = parseOwner(owner);
      const roles: [Role, string[] | undefined][] = [['varlist', sections.varnamelist], ['stringvarlist', sections.stringvarnamelist], ['constfile', sections.constfile]];
      for (const [role, list] of roles) {
        for (const p of list ?? []) {
          const hit = resolveCI(dir, p);
          if (hit && norm(hit) === target) return { role, owner };
        }
      }
    }
  }
  return undefined;
}

/** program\varlist_roadvehicle.txt (or the string list) as a lower-case set, if present. */
export function builtInNames(omsiPath: string | undefined, kind: 'var' | 'str'): Set<string> | undefined {
  if (!omsiPath) return undefined;
  const file = resolveCI(omsiPath, `program/${kind === 'var' ? '' : 'string'}varlist_roadvehicle.txt`);
  return file && existsSync(file) ? new Set(names(file).map((n) => n.toLowerCase())) : undefined;
}
