import * as path from 'node:path';
import { ExtensionContext } from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export function activate(context: ExtensionContext): void {
  const module = context.asAbsolutePath(path.join('out', 'server.js'));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    // .txt files are only acted on when a .bus/.ovh/.sco references them as a varlist or constfile.
    documentSelector: [{ scheme: 'file', language: 'osc' }, { scheme: 'file', pattern: '**/*.txt' }],
    synchronize: { configurationSection: 'oscLens' },
  };
  client = new LanguageClient('oscLens', 'OSC Lens', serverOptions, clientOptions);
  void client.start();
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
