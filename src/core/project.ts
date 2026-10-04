import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tokenize } from './lexer';

export interface ProjectInfo {
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

function parseConst(path: string | undefined, constants: Set<string>, curves: Set<string>): void {
  if (!path || !existsSync(path)) return;
  const raw = lines(path).map((l) => l.trim());
  for (let i = 0; i < raw.length; i++) {
    const tag = raw[i].toLowerCase();
    if (tag === '[const]' && raw[i + 1]) constants.add(raw[i + 1].toLowerCase());
    else if (tag === '[newcurve]' && raw[i + 1]) curves.add(raw[i + 1].toLowerCase());
  }
}

function macrosOf(path: string | undefined): string[] {
  if (!path || !existsSync(path)) return [];
  return tokenize(read(path)).filter((t) => t.text.startsWith('{macro:') && t.text.endsWith('}')).map((t) => t.text.slice(7, -1).toLowerCase());
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
      const missing: string[] = [];
      const found = (p: string): string | undefined => {
        const hit = resolveCI(dir, p);
        if (!hit || !existsSync(hit)) missing.push(p);
        return hit;
      };
      const scripts = (sections.script ?? []).map((p) => resolveCI(dir, p) ?? resolve(dir, p.replace(/\\/g, '/')));
      const index = scripts.findIndex((p) => norm(p) === target);
      if (index < 0) continue;

      const variables = new Set<string>();
      const stringVariables = new Set<string>();
      const constants = new Set<string>();
      const curves = new Set<string>();
      const isVehicle = /\.(bus|ovh)$/i.test(entry);
      let variablesComplete = !isVehicle;
      let stringVariablesComplete = !isVehicle;
      if (isVehicle && omsiPath) {
        const builtIn = resolveCI(omsiPath, 'program/varlist_roadvehicle.txt');
        const builtInStr = resolveCI(omsiPath, 'program/stringvarlist_roadvehicle.txt');
        if (builtIn && existsSync(builtIn)) { names(builtIn).forEach((n) => variables.add(n.toLowerCase())); variablesComplete = true; } else missing.push('program/varlist_roadvehicle.txt (under oscLens.omsiPath)');
        if (builtInStr && existsSync(builtInStr)) { names(builtInStr).forEach((n) => stringVariables.add(n.toLowerCase())); stringVariablesComplete = true; } else missing.push('program/stringvarlist_roadvehicle.txt (under oscLens.omsiPath)');
      }
      for (const p of sections.varnamelist ?? []) names(found(p)).forEach((n) => variables.add(n.toLowerCase()));
      for (const p of sections.stringvarnamelist ?? []) names(found(p)).forEach((n) => stringVariables.add(n.toLowerCase()));
      for (const p of sections.constfile ?? []) parseConst(found(p), constants, curves);

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
      return { missing, owner, scripts, index, variables, stringVariables, constants, curves, earlierMacros, laterMacros, variablesComplete, stringVariablesComplete, callbacks };
    }
  }
  return undefined;
}

export const ownerName = (p: ProjectInfo): string => basename(p.owner);
