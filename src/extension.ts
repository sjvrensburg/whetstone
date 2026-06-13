import * as vscode from 'vscode';
import { createContainer } from './container';
import { registerViews } from './ui';
import { createUICommands } from './ui/commands';
import type { UICommandDeps } from './ui/commands';
import { getSettings } from './shared/config';
import { WhetstoneSecrets } from './shared/secrets';
import { createProvider, resolveApiKey } from './providers/registry';
import { createRefusalGuard } from './guard';
import { LedgerImpl, LedgerStore, resolveLedgerDir } from './ledger';
import { renderReportDocument } from './ledger';
import { ConsentGate } from './consent';
import { BriefCapture, BriefFileStore } from './brief';
import { Dial } from './friction/dial';
import { FrictionStatusBar, createFrictionControlCommands } from './friction/control';
import { ClaimFirstGate } from './friction/claimFirst';
import { CLAIM_PROMPT, CLAIM_PLACEHOLDER, CLAIM_TITLE } from './friction/claimFirst';

/**
 * Extension host entry point. Owns lifecycle only: it builds the dependency
 * container, wires domain services, registers views and commands. By the
 * Component Overview boundary, NO business logic lives in this file — every
 * behaviour belongs to a domain-service module reached through the container.
 */
export function activate(context: vscode.ExtensionContext): void {
  const container = createContainer(context);

  // --- Register views first (populates container.ui with providers) ---
  registerViews(context, container);

  // --- Wire domain services ---
  const settings = getSettings();
  const secrets = new WhetstoneSecrets(context.secrets);

  // Ledger (task 07)
  const ledgerDir = resolveLedgerDir({
    globalStoragePath: context.globalStorageUri.fsPath,
    workspaceFolders: vscode.workspace.workspaceFolders?.map((f) => ({
      uri: { fsPath: f.uri.fsPath },
    })),
    ledgerInWorkspace: settings.ledgerInWorkspace,
  });
  const ledgerStore = new LedgerStore(ledgerDir);
  const ledger = new LedgerImpl({
    store: ledgerStore,
    keyProvider: () => secrets.getOrCreateSigningKey(),
    checkpointInterval: 100,
  });
  container.ledger = ledger;

  // Brief (task 14)
  const briefStore = new BriefFileStore(ledgerDir);
  const briefCapture = new BriefCapture(briefStore);

  // Friction dial (task 20, ADR-008)
  const dial = new Dial({
    level: settings.frictionLevel,
    floor: settings.frictionFloor,
    overrides: settings.frictionOverrides,
  });

  // Claim-first gate (instrument C, task 22)
  const claimFirstGate = new ClaimFirstGate({ dial, ledger, now: () => new Date().toISOString() });

  const frictionBar = new FrictionStatusBar(dial);
  context.subscriptions.push(frictionBar);

  // React to settings changes — update dial without reload
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('whetstone')) {
        const updated = getSettings();
        dial.updateConfig({
          level: updated.frictionLevel,
          floor: updated.frictionFloor,
          overrides: updated.frictionOverrides,
        });
      }
    }),
  );

  // Consent gate (task 13)
  const consentGate = new ConsentGate({
    secrets: { hasApiKey: () => secrets.hasApiKey(), setApiKey: (k) => secrets.setApiKey(k) },
    ledger,
    settings,
    prompter: {
      showConsentDisclosure: (d) => {
        const msg = `Whetstone wants to send text to ${d.provider} (${d.model}) for ${d.purpose}.\n\n${d.retention}\n\nAllow this send?`;
        return Promise.resolve(
          vscode.window
            .showInformationMessage(msg, { modal: true }, 'Allow')
            .then((v) => v === 'Allow'),
        );
      },
      promptForApiKey: (provider) => {
        return Promise.resolve(
          vscode.window.showInputBox({
            title: `API Key for ${provider}`,
            prompt: `Enter your ${provider} API key. It will be stored securely in VS Code SecretStorage.`,
            placeHolder: 'sk-...',
            password: true,
          }),
        );
      },
    },
  });

  // --- Build UI command deps ---
  const ui = container.ui as {
    coachingView: import('./ui/coachingView').CoachingTreeDataProvider;
    ledgerView: import('./ui/ledgerView').LedgerTreeDataProvider;
  };

  const deps: UICommandDeps = {
    consentGate,
    buildCoachingDeps: async () => {
      const apiKey = await resolveApiKey(secrets);
      if (!apiKey) {
        throw new Error('No API key available. Please set your API key and try again.');
      }
      const provider = createProvider(settings, apiKey);
      const guard = createRefusalGuard({ provider });
      return { provider, guard, ledger, maxAttempts: 2 };
    },
    briefCapture,
    briefPrompter: {
      showInputStep: (step) =>
        Promise.resolve(
          vscode.window.showInputBox({
            title: step.title,
            prompt: step.prompt,
            placeHolder: step.placeholder,
            value: step.value,
          }),
        ),
    },
    coachingView: ui.coachingView,
    ledgerView: ui.ledgerView,
    ledger: {
      append: (e) => ledger.append(e as Parameters<typeof ledger.append>[0]),
      get isPaused() {
        return ledger.isPaused;
      },
      pause: () => ledger.pause(),
      resume: () => ledger.resume(),
      get integrityStatus() {
        return ledger.integrityStatus;
      },
      report: () => ledger.report(),
      exportDisclosure: () => ledger.exportDisclosure(),
    },
    getActiveEditor: () => vscode.window.activeTextEditor,
    openReportDocument: async () => {
      const report = await ledger.report();
      const content = renderReportDocument(report);
      const doc = await vscode.workspace.openTextDocument({ content, language: 'markdown' });
      await vscode.window.showTextDocument(doc);
    },
    openDisclosureDocument: async () => {
      const text = await ledger.exportDisclosure();
      const doc = await vscode.workspace.openTextDocument({ content: text });
      await vscode.window.showTextDocument(doc);
    },
    claimFirstGate,
    claimPrompter: {
      showClaimInput: () =>
        Promise.resolve(
          vscode.window.showInputBox({
            title: CLAIM_TITLE,
            prompt: CLAIM_PROMPT,
            placeHolder: CLAIM_PLACEHOLDER,
          }),
        ),
    },
  };

  // --- Register commands ---
  const commands = createUICommands(deps);
  for (const command of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(command.id, command.handler));
  }

  // --- Register friction control commands (task 20) ---
  const frictionCommands = createFrictionControlCommands({ dial });
  for (const command of frictionCommands) {
    context.subscriptions.push(vscode.commands.registerCommand(command.id, command.handler));
  }
}

export function deactivate(): void {
  // Nothing to tear down; registered disposables are owned by context.subscriptions.
}
