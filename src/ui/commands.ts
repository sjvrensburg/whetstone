/**
 * `ui/commands.ts` — Command registration for the sidebar UI (ADR-007, task 17).
 *
 * Creates command descriptors that wire domain services (consent, coaching,
 * ledger, brief) to VS Code command handlers. All business logic stays in the
 * domain modules; this file is presentation/wiring only.
 *
 * Commands:
 * - `whetstone.coachSelection` — consent → coaching → render in tree
 * - `whetstone.revealSpan` — show the anchored span in the editor
 * - `whetstone.toggleLedger` — pause or resume the ledger
 * - `whetstone.openTransparencyReport` — render report as document
 * - `whetstone.exportDisclosure` — render disclosure as document
 * - `whetstone.editBrief` — run the brief capture flow
 */

import * as vscode from 'vscode';
import type { ConsentGate } from '../consent';
import type { CoachingTurnDeps, CoachingTurnInput } from '../coaching';
import { runCoachingTurn } from '../coaching';
import type { BriefCapture, BriefPrompter } from '../brief';
import type { DocumentLanguage, Observation } from '../shared/types';
import type { CoachingTreeDataProvider, CoachingDocumentRef } from './coachingView';
import { revealObservationSpan } from './coachingView';
import type { ObservationItem } from './coachingView';
import type { LedgerTreeDataProvider } from './ledgerView';
import type { TelemetrySink } from '../telemetry';
import type { ClaimFirstGate, ClaimPrompter } from '../friction';

// ---------------------------------------------------------------------------
// DI seam — all services the commands need, injected for testability
// ---------------------------------------------------------------------------

/** The set of services the UI commands need. */
export interface UICommandDeps {
  /** The consent gate to check before any cloud egress. */
  consentGate: ConsentGate;
  /**
   * Build the coaching turn deps lazily. Called AFTER consent so the API key
   * (set by the consent gate) is available. This factory pattern avoids the
   * problem of creating a provider at activation time with a missing key.
   */
  buildCoachingDeps: () => Promise<CoachingTurnDeps>;
  /** The brief capture service. */
  briefCapture: BriefCapture;
  /** The UI seam for brief input steps. */
  briefPrompter: BriefPrompter;
  /** The coaching TreeView data provider. */
  coachingView: CoachingTreeDataProvider;
  /** The ledger TreeView data provider. */
  ledgerView: LedgerTreeDataProvider;
  /** The ledger instance (for toggle/report/disclosure). */
  ledger: LedgerControl;
  /** Returns the active text editor (seam for testing). */
  getActiveEditor: () => vscode.TextEditor | undefined;
  /** Renders the transparency report as a Markdown document and opens it. */
  openReportDocument: () => Promise<void>;
  /** Renders the disclosure and opens it. */
  openDisclosureDocument: () => Promise<void>;
  /**
   * Optional telemetry sink (task 18.3). When present, records activation (on
   * a successful coaching interaction), ledger on/off state, and report /
   * disclosure generation events. Optional so existing tests are unaffected.
   */
  telemetry?: TelemetrySink;
  /** The claim-first commitment gate (instrument C, task 22). */
  claimFirstGate: ClaimFirstGate;
  /** The UI seam for the claim-first input prompt. */
  claimPrompter: ClaimPrompter;
}

/** The ledger control surface commands need (extends the read-only view). */
export interface LedgerControl {
  append(e: { ts: string; type: string; payload: unknown }): Promise<void>;
  isPaused: boolean;
  pause(): Promise<void>;
  resume(): Promise<void>;
  integrityStatus: { intact: boolean; brokenAt?: number };
  report(): Promise<{
    countsByType: Record<string, number>;
    integrity: { intact: boolean; brokenAt?: number };
  }>;
  exportDisclosure(): Promise<string>;
}

// ---------------------------------------------------------------------------
// Command descriptor
// ---------------------------------------------------------------------------

export interface CommandDescriptor {
  readonly id: string;
  readonly handler: (...args: unknown[]) => unknown;
}

// ---------------------------------------------------------------------------
// Command: coachSelection
// ---------------------------------------------------------------------------

/**
 * The "Coach this selection" command handler.
 *
 * Flow:
 * 1. Validate there is an active editor with a non-empty selection.
 * 2. Call the consent gate (F7) — blocks on first egress until consented.
 * 3. Build the coaching deps lazily (resolves API key after consent).
 * 4. Run the coaching turn pipeline (task 12: provider → guard → ledger).
 * 5. On success: refresh the coaching TreeView with the results.
 * 6. On failure: show an error message.
 */
async function handleCoachSelection(deps: UICommandDeps): Promise<void> {
  const editor = deps.getActiveEditor();
  if (!editor) {
    vscode.window.showInformationMessage('Open a file first, then select text to coach.');
    return;
  }

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection).trim();
  if (!selectedText) {
    vscode.window.showInformationMessage('Select some text to coach.');
    return;
  }

  // --- Consent gate (F7): must run before any cloud send ---
  const consentResult = await deps.consentGate.ensureConsent('coaching');
  if (!consentResult.ok) {
    vscode.window.showInformationMessage(`Coaching cancelled: ${consentResult.reason}`);
    return;
  }

  // --- Resolve coaching deps (lazy — key is now available) ---
  const coachingDeps = await deps.buildCoachingDeps();

  // --- Claim-first gate (instrument C, task 22): runs before coaching ---
  const claimResult = await deps.claimFirstGate.gate(deps.claimPrompter);
  if (!claimResult.ok) {
    vscode.window.showInformationMessage(claimResult.reason);
    return;
  }

  // --- Resolve document language ---
  const lang = editor.document.languageId;
  const documentLanguage: DocumentLanguage = lang === 'latex' ? 'latex' : 'markdown';

  // --- Build input (with optional brief + claim) ---
  const brief = await deps.briefCapture.read();
  const input: CoachingTurnInput = {
    selectionText: selectedText,
    anchorBase: editor.document.offsetAt(selection.start),
    documentLanguage,
    brief,
    ...(claimResult.claim ? { claim: claimResult.claim } : {}),
  };

  // --- Run coaching turn (task 12 orchestration: provider → guard → ledger) ---
  const result = await runCoachingTurn(coachingDeps, input);

  if (!result.ok) {
    vscode.window.showWarningMessage(`Coaching failed: ${result.error.message}`);
    return;
  }

  // --- A successful coaching interaction is an activation event (task 18.3). ---
  deps.telemetry?.recordActivation();

  // --- Render in coaching TreeView ---
  const docRef: CoachingDocumentRef = {
    uri: editor.document.uri,
    anchorBase: input.anchorBase,
  };
  deps.coachingView.refresh(result.coaching, docRef);
}

// ---------------------------------------------------------------------------
// Command: revealSpan
// ---------------------------------------------------------------------------

/**
 * The reveal-span command handler. Triggered when the user clicks a coaching
 * observation item. Resolves the anchor to an absolute document range and
 * reveals it in the editor.
 */
function handleRevealSpan(deps: UICommandDeps, observation: Observation): void {
  const docRef = deps.coachingView.documentRef;
  const editor = deps.getActiveEditor();
  if (!docRef || !editor) {
    return;
  }
  revealObservationSpan(observation, docRef, editor);
}

// ---------------------------------------------------------------------------
// Command: toggleLedger
// ---------------------------------------------------------------------------

/**
 * The toggle-ledger command handler. Pauses if active, resumes if paused.
 * Refreshes the ledger TreeView after the change.
 */
async function handleToggleLedger(deps: UICommandDeps): Promise<void> {
  if (deps.ledger.isPaused) {
    await deps.ledger.resume();
    vscode.window.showInformationMessage('Ledger resumed.');
    deps.telemetry?.recordLedgerState({ on: true });
  } else {
    await deps.ledger.pause();
    vscode.window.showInformationMessage('Ledger paused.');
    deps.telemetry?.recordLedgerState({ on: false });
  }
  deps.ledgerView.refresh();
}

// ---------------------------------------------------------------------------
// Command: openTransparencyReport
// ---------------------------------------------------------------------------

/** Open the transparency report as a generated Markdown document. */
async function handleOpenTransparencyReport(deps: UICommandDeps): Promise<void> {
  await deps.openReportDocument();
  deps.telemetry?.recordReportGenerated({ kind: 'report' });
}

// ---------------------------------------------------------------------------
// Command: exportDisclosure
// ---------------------------------------------------------------------------

/** Open the ICMJE disclosure as a generated text document. */
async function handleExportDisclosure(deps: UICommandDeps): Promise<void> {
  await deps.openDisclosureDocument();
  deps.telemetry?.recordReportGenerated({ kind: 'disclosure' });
}

// ---------------------------------------------------------------------------
// Command: editBrief
// ---------------------------------------------------------------------------

/** Run the brief capture flow. On success, shows a confirmation. */
async function handleEditBrief(deps: UICommandDeps): Promise<void> {
  const result = await deps.briefCapture.capture(deps.briefPrompter);
  if (result.ok) {
    vscode.window.showInformationMessage('Writing brief saved.');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** All command IDs contributed by the UI. */
export const UI_COMMAND_IDS = [
  'whetstone.coachSelection',
  'whetstone.revealSpan',
  'whetstone.toggleLedger',
  'whetstone.openTransparencyReport',
  'whetstone.exportDisclosure',
  'whetstone.editBrief',
] as const;

/**
 * Create all UI command descriptors. Each handler receives the shared `deps`
 * object so commands can call domain services without importing vscode-coupled
 * modules directly.
 */
export function createUICommands(deps: UICommandDeps): CommandDescriptor[] {
  return [
    {
      id: 'whetstone.coachSelection',
      handler: () => handleCoachSelection(deps),
    },
    {
      id: 'whetstone.revealSpan',
      handler: (...args: unknown[]) => {
        const item = args[0] as ObservationItem | undefined;
        if (item?.observation) {
          handleRevealSpan(deps, item.observation);
        }
      },
    },
    {
      id: 'whetstone.toggleLedger',
      handler: () => handleToggleLedger(deps),
    },
    {
      id: 'whetstone.openTransparencyReport',
      handler: () => handleOpenTransparencyReport(deps),
    },
    {
      id: 'whetstone.exportDisclosure',
      handler: () => handleExportDisclosure(deps),
    },
    {
      id: 'whetstone.editBrief',
      handler: () => handleEditBrief(deps),
    },
  ];
}
