import { fileURLToPath } from 'node:url';
import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, DiagnosticSeverity,
  CompletionItemKind, InsertTextFormat, MarkupKind, Diagnostic, CompletionItem, Hover, SemanticTokensBuilder,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, Severity } from './core/analyze';
import { complete } from './core/completion';
import { loadLanguage } from './core/language';
import { analyzeConstfile, analyzeVarlist, completeDecl, semanticTokensConst, semanticTokensVarlist } from './core/declfiles';
import { builtInNames, findRole, loadOwnerProject, loadProject, ProjectInfo } from './core/project';
import { pathToFileURL } from 'node:url';

interface Settings { omsiPath?: string; stackAnalysis: boolean; disabledRules: string[] }
const defaults: Settings = { stackAnalysis: false, disabledRules: [] };

const TOKEN_TYPES = ['keyword', 'variable', 'number', 'function', 'comment'] as const;

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const language = loadLanguage();
let hasConfiguration = false;

connection.onInitialize((params) => {
  hasConfiguration = !!params.capabilities.workspace?.configuration;
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: { triggerCharacters: ['(', '.', '{', '$'] },
      hoverProvider: true,
      definitionProvider: true,
      semanticTokensProvider: { legend: { tokenTypes: [...TOKEN_TYPES], tokenModifiers: ['readonly'] }, full: true },
    },
  };
});

async function settings(uri: string): Promise<Settings> {
  if (!hasConfiguration) return defaults;
  const got = (await connection.workspace.getConfiguration({ scopeUri: uri, section: 'oscLens' })) as Partial<Settings> | null;
  return { ...defaults, ...(got ?? {}) };
}

const severity: Record<Severity, DiagnosticSeverity> = {
  error: DiagnosticSeverity.Error, warning: DiagnosticSeverity.Warning, info: DiagnosticSeverity.Information,
};

function project(uri: string, s: Settings): ProjectInfo | undefined {
  try { return loadProject(fileURLToPath(uri), s.omsiPath || undefined); } catch { return undefined; }
}

async function findingsFor(doc: TextDocument, s: Settings) {
  if (/\.osc$/i.test(doc.uri)) return analyze(doc.getText(), { project: project(doc.uri, s), stackAnalysis: s.stackAnalysis }).findings;
  // Any other .txt is only handled when a .bus/.ovh/.sco references it as a varlist or constfile.
  let role;
  try { role = findRole(fileURLToPath(doc.uri)); } catch { role = undefined; }
  if (!role) return [];
  if (role.role === 'constfile') return analyzeConstfile(doc.getText());
  return analyzeVarlist(doc.getText(), builtInNames(s.omsiPath || undefined, role.role === 'varlist' ? 'var' : 'str'));
}

async function validate(doc: TextDocument): Promise<void> {
  const s = await settings(doc.uri);
  const result = { findings: await findingsFor(doc, s) };
  const diagnostics: Diagnostic[] = result.findings
    .filter((f) => !s.disabledRules.includes(f.code))
    .map((f) => ({
      severity: severity[f.severity],
      range: { start: { line: f.line, character: f.col }, end: { line: f.endLine, character: f.endCol } },
      message: `${f.message} [${f.evidence}]`,
      code: f.code,
      source: 'osc-lens',
    }));
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidChangeContent((e) => { void validate(e.document); });
documents.onDidClose((e) => connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] }));

function tokenPrefix(doc: TextDocument, line: number, character: number): string {
  const text = doc.getText({ start: { line, character: 0 }, end: { line, character } });
  const m = /\S*$/.exec(text);
  return m ? m[0] : '';
}

const itemKind = { operator: CompletionItemKind.Operator, keyword: CompletionItemKind.Keyword, variable: CompletionItemKind.Variable, function: CompletionItemKind.Function, constant: CompletionItemKind.Constant, snippet: CompletionItemKind.Snippet } as const;

function declRole(uri: string) {
  if (/\.osc$/i.test(uri)) return undefined;
  try { return findRole(fileURLToPath(uri)); } catch { return undefined; }
}

connection.languages.semanticTokens.on((params) => {
  const builder = new SemanticTokensBuilder();
  const doc = documents.get(params.textDocument.uri);
  const role = doc ? declRole(doc.uri) : undefined;
  if (!doc || !role) return builder.build();
  const tokens = role.role === 'constfile' ? semanticTokensConst(doc.getText()) : semanticTokensVarlist(doc.getText());
  for (const t of tokens) builder.push(t.line, t.col, t.length, TOKEN_TYPES.indexOf(t.type), t.readonly ? 1 : 0);
  return builder.build();
});

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const s = await settings(doc.uri);
  const role = declRole(doc.uri);
  if (role) {
    const p = loadOwnerProject(role.owner, s.omsiPath || undefined);
    const lineText = doc.getText({ start: { line: params.position.line, character: 0 }, end: params.position });
    return completeDecl(doc.getText(), params.position.line, lineText, {
      role: role.role,
      used: p.used,
      declared: { var: p.variables, str: p.stringVariables, const: p.constants, curve: p.curves },
      builtIns: builtInNames(s.omsiPath || undefined, role.role === 'stringvarlist' ? 'str' : 'var'),
    }).map((i) => ({
      label: i.label, detail: i.detail,
      kind: i.snippet ? CompletionItemKind.Snippet : CompletionItemKind.Variable,
      insertText: i.insertText ?? i.label,
      insertTextFormat: i.snippet ? InsertTextFormat.Snippet : InsertTextFormat.PlainText,
    }));
  }
  const analysis = analyze(doc.getText(), { project: undefined });
  const prefix = tokenPrefix(doc, params.position.line, params.position.character);
  return complete(prefix, { language, project: project(doc.uri, s), macros: analysis.macros, triggers: analysis.triggers })
    .map((i) => ({ label: i.label, kind: itemKind[i.kind], detail: i.detail, documentation: i.documentation ? { kind: MarkupKind.PlainText, value: i.documentation } : undefined, insertText: i.label }));
});

connection.onHover((params): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = doc.getText({ start: { line: params.position.line, character: 0 }, end: { line: params.position.line + 1, character: 0 } });
  const re = /\S+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (params.position.character < m.index || params.position.character > m.index + m[0].length) continue;
    const word = m[0];
    const op = language.operatorByToken.get(word);
    if (op) {
      const effect = op.pops === null ? 'string stack' : `pops ${op.pops}, pushes ${op.pushes}`;
      return { contents: { kind: MarkupKind.Markdown, value: `**${op.token}** — ${effect}\n\n${op.doc}\n\n_evidence: ${op.evidence}_ · \`${op.source}\`${op.note ? `\n\n${op.note}` : ''}` } };
    }
    const d = language.directives.find((x) => word === `{${x.token}}` || word.startsWith(`{${x.token}:`));
    if (d) return { contents: { kind: MarkupKind.Markdown, value: `**{${d.token}}**\n\n${d.doc}\n\n_evidence: ${d.evidence}_ · \`${d.source}\`` } };
    const decl = declarationAt(doc.uri, word);
    if (decl?.decl.value !== undefined) return { contents: { kind: MarkupKind.Markdown, value: '**' + decl.name + '** = ' + decl.decl.value + '\n\n`' + decl.decl.file + ':' + (decl.decl.line + 1) + '`' } };
    if (decl?.decl.points) return { contents: { kind: MarkupKind.Markdown, value: '**' + decl.name + '** curve\n\n' + (decl.decl.points.map(([x, y]) => '(' + x + ', ' + y + ')').join(' · ') || '_no points_') + '\n\n`' + decl.decl.file + ':' + (decl.decl.line + 1) + '`' } };
    const cb = /^\(M\.V\.(.+)\)$/.exec(word);
    if (cb) {
      const info = language.callbacks.find((c) => c.name.toLowerCase() === cb[1].toLowerCase());
      if (info) return { contents: { kind: MarkupKind.Markdown, value: `**${info.name}** (${info.group})\n\n_evidence: ${info.evidence}_ · \`${info.source}\`${info.note ? `\n\n${info.note}` : ''}` } };
    }
    return null;
  }
  return null;
});

const DECL = /^\((.)\.(.)\.(.+)\)$/;

function declKey(x: string, y: string, name: string): string | undefined {
  const kind = x === 'C' ? 'const' : x === 'F' ? 'curve' : (x === 'L' || x === 'S') && y === 'L' ? 'var' : (x === 'L' || x === 'S') && y === '$' ? 'str' : undefined;
  return kind ? kind + ':' + name.toLowerCase() : undefined;
}

function declarationAt(uri: string, word: string) {
  const m = DECL.exec(word);
  if (!m || !/\.osc$/i.test(uri)) return undefined;
  const key = declKey(m[1], m[2], m[3]);
  const decl = key ? project(uri, defaults)?.declarations.get(key) : undefined;
  return decl ? { name: m[3], decl } : undefined;
}

connection.onDefinition(async (params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const line = doc.getText({ start: { line: params.position.line, character: 0 }, end: { line: params.position.line + 1, character: 0 } });
  const s = await settings(doc.uri);
  for (const m of line.matchAll(/\S+/g)) {
    const start = m.index ?? 0;
    if (params.position.character < start || params.position.character > start + m[0].length) continue;
    const parts = DECL.exec(m[0]);
    const key = parts ? declKey(parts[1], parts[2], parts[3]) : undefined;
    const decl = key ? project(doc.uri, s)?.declarations.get(key) : undefined;
    if (!decl) return null;
    return { uri: pathToFileURL(decl.file).toString(), range: { start: { line: decl.line, character: 0 }, end: { line: decl.line, character: 1000 } } };
  }
  return null;
});

documents.listen(connection);
connection.listen();
