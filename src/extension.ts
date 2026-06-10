import * as vscode from 'vscode';
import { createContainer } from './container';
import { createCommands } from './commands';
import { registerViews } from './ui';

/**
 * Extension host entry point. Owns lifecycle only: it builds the dependency
 * container, registers the (currently no-op) commands, and wires the sidebar
 * views. By the Component Overview boundary, NO business logic lives in this
 * file — every behaviour belongs to a domain-service module reached through the
 * container.
 */
export function activate(context: vscode.ExtensionContext): void {
  const container = createContainer(context);

  for (const command of createCommands(container)) {
    context.subscriptions.push(vscode.commands.registerCommand(command.id, command.handler));
  }

  registerViews(context, container);
}

export function deactivate(): void {
  // Nothing to tear down yet; registered disposables are owned by context.subscriptions.
}
