import { fileURLToPath } from 'node:url';
import {
  createConnection, ProposedFeatures, TextDocuments, TextDocumentSyncKind, DiagnosticSeverity,
  CompletionItemKind, MarkupKind, Diagnostic, CompletionItem, Hover,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { analyze, Severity } from './core/analyze';
import { complete } from './core/completion';
import { loadLanguage } from './core/language';
import { loadProject, ProjectInfo } from './core/project';

interface Settings { omsiPath?: string; stackAnalysis: boolean; disabledRules: string[] }
const defaults: Settings = { stackAnalysis: false, disabledRules: [] };

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

async function validate(doc: TextDocument): Promise<void> {
  const s = await settings(doc.uri);
  const result = analyze(doc.getText(), { project: project(doc.uri, s), stackAnalysis: s.stackAnalysis });
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

connection.onCompletion(async (params): Promise<CompletionItem[]> => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const s = await settings(doc.uri);
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
    const cb = /^\(M\.V\.(.+)\)$/.exec(word);
    if (cb) {
      const info = language.callbacks.find((c) => c.name.toLowerCase() === cb[1].toLowerCase());
      if (info) return { contents: { kind: MarkupKind.Markdown, value: `**${info.name}** (${info.group})\n\n_evidence: ${info.evidence}_ · \`${info.source}\`${info.note ? `\n\n${info.note}` : ''}` } };
    }
    return null;
  }
  return null;
});

documents.listen(connection);
connection.listen();
