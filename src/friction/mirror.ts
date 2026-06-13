/**
 * Live process self-mirror — instrument E (ADR-008, task 25).
 *
 * Surfaces the writer's own process back to them, live — the "mindfulness
 * mirror" from the original Q-Ledger idea, pointed at the *writer* for
 * self-awareness, never at a stranger as proof. A sidebar view shows the
 * draft's composition (typed-in-own-bursts vs pasted/quarantined vs
 * coached-on), integrity status, and engagement signals, updating as they
 * work. Dial-gated (hidden → live).
 *
 * Pure logic; no `vscode` import in this module. The `MirrorViewDataProvider`
 * (a thin VS Code TreeView adapter) lives here for co-location but requires
 * the `vscode` import — it is only instantiated in the extension host.
 *
 * Framing invariant (ADR-008 honest-claim constraint):
 *   - No "human score" or number implying proof of personhood.
 *   - No prose surfaced — metadata only.
 *   - Read-only: the mirror reflects, never grades.
 */

import type { MirrorState } from './presets';
import type { LedgerEventType, TransparencyReport } from '../shared/types';

// ---------------------------------------------------------------------------
// Composition proportions
// ---------------------------------------------------------------------------

/**
 * The composition of the session's writing activity, expressed as counts and
 * proportions of three categories. This is a *mirror*, not a *grade* — the
 * numbers reflect process, not personhood.
 */
export interface CompositionSnapshot {
  /** Events that indicate the writer engaging with their own thinking. */
  ownBursts: number;
  /** Events involving pasted, quarantined, or externally-inserted text. */
  pastedOrQuarantined: number;
  /** Events involving AI coaching interactions. */
  coachedOn: number;
  /** Total event count (sum of the three). */
  total: number;
  /** Proportion of own-bursts (0–1, 0 if total is 0). */
  ownBurstsRatio: number;
  /** Proportion of pasted/quarantined (0–1, 0 if total is 0). */
  pastedOrQuarantinedRatio: number;
  /** Proportion of coached-on (0–1, 0 if total is 0). */
  coachedOnRatio: number;
}

/**
 * The full mirror snapshot — composition proportions + integrity status.
 * Read-only; computed from the ledger's report and verify result.
 *
 * Named `MirrorSnapshot` (not `MirrorState`) to avoid collision with the
 * dial-instrument state type `MirrorState` from `presets.ts`.
 */
export interface MirrorSnapshot {
  /** Whether the mirror is visible (dial-gated). */
  readonly visible: boolean;
  /** Composition proportions. `null` if no events yet. */
  readonly composition: CompositionSnapshot | null;
  /** Chain integrity status from `Ledger.verify()`. */
  readonly integrity: { intact: boolean; brokenAt?: number };
}

// ---------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------

/**
 * Event types that indicate the writer engaging with their own thinking:
 * acting on suggestions, providing teach-back summaries, or capturing claims.
 * These are "own bursts" — the writer actively working.
 */
const OWN_BURST_TYPES: ReadonlySet<LedgerEventType> = new Set([
  'suggestion_acted',
  'teach_back',
  'claim_captured',
  'paste_claim',
]);

/**
 * Event types that involve pasted, quarantined, or externally-inserted text.
 * These indicate material that came from outside the writer's own typing.
 */
const PASTED_QUARANTINED_TYPES: ReadonlySet<LedgerEventType> = new Set([
  'external_insert',
  'paste_quarantine',
]);

/**
 * Event types that involve AI coaching interactions — either requested or
 * proactive. These indicate the writer sought or received coaching.
 */
const COACHED_ON_TYPES: ReadonlySet<LedgerEventType> = new Set([
  'ai_consult',
  'push_coaching',
]);

/**
 * All event types tracked by the mirror for composition purposes.
 * Ledger-internal events (paused, resumed, cloud_send) are excluded —
 * they are operational, not compositional.
 */
const COMPOSITION_TYPES: ReadonlySet<LedgerEventType> = new Set([
  ...OWN_BURST_TYPES,
  ...PASTED_QUARANTINED_TYPES,
  ...COACHED_ON_TYPES,
]);

// ---------------------------------------------------------------------------
// Pure computation — composition from report
// ---------------------------------------------------------------------------

/**
 * Compute the composition proportions from a transparency report.
 *
 * This is a pure function with no side effects — it reads `countsByType`
 * and produces a `CompositionSnapshot`. Called whenever the mirror needs
 * to refresh (debounced by the caller, never lagging typing).
 *
 * @param countsByType — the event counts from the transparency report
 * @returns `CompositionSnapshot`, or `null` if no compositional events exist
 */
export function computeComposition(
  countsByType: Record<LedgerEventType, number>,
): CompositionSnapshot | null {
  let ownBursts = 0;
  let pastedOrQuarantined = 0;
  let coachedOn = 0;

  for (const type of COMPOSITION_TYPES) {
    const count = countsByType[type] ?? 0;
    if (OWN_BURST_TYPES.has(type)) {
      ownBursts += count;
    } else if (PASTED_QUARANTINED_TYPES.has(type)) {
      pastedOrQuarantined += count;
    } else if (COACHED_ON_TYPES.has(type)) {
      coachedOn += count;
    }
  }

  const total = ownBursts + pastedOrQuarantined + coachedOn;

  if (total === 0) {
    return null;
  }

  return {
    ownBursts,
    pastedOrQuarantined,
    coachedOn,
    total,
    ownBurstsRatio: ownBursts / total,
    pastedOrQuarantinedRatio: pastedOrQuarantined / total,
    coachedOnRatio: coachedOn / total,
  };
}

// ---------------------------------------------------------------------------
// Labels — mirror-not-grade framing (ADR-008)
// ---------------------------------------------------------------------------

/**
 * Category labels used in the mirror view. These are intentionally
 * descriptive and non-judgmental — they describe *what happened*, not
 * whether the writer was "good" or "bad".
 *
 * Invariant: no label asserts a "human score" or proof of personhood.
 */
export const LABELS = {
  ownBursts: 'Your engagement',
  pastedOrQuarantined: 'External inserts',
  coachedOn: 'AI coaching',
  integrity: 'Ledger integrity',
  totalEvents: 'Total activity',
  empty: 'No activity yet — start writing to see your process here.',
  /** The section header for the mirror view. */
  viewTitle: 'Process mirror',
  /** The scoping note — mirror, not grade (ADR-008). */
  scopingNote: 'This reflects your writing process — it is not a score.',
} as const;

/** The set of words/phrases that MUST NOT appear in any label. */
const FORBIDDEN_PHRASES = [
  'human score',
  'proof of personhood',
  'proof of human',
  'verified human',
  'humanness',
  'humanity score',
  'ai score',
  'authenticity score',
  'authorship score',
  'grade',
  'rating',
] as const;

/**
 * Assert that no label (or any provided text) contains forbidden phrases.
 * Used in tests to enforce the mirror-not-grade invariant.
 */
export function assertNoProofOfPersonhoodLanguage(text: string): boolean {
  const lower = text.toLowerCase();
  for (const phrase of FORBIDDEN_PHRASES) {
    if (lower.includes(phrase)) {
      return false;
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// DI seams
// ---------------------------------------------------------------------------

/**
 * Dependencies injected for testability. Follows the same DI pattern as
 * `TeachBackDeps` (task 23) and `ClaimFirstGateDeps` (task 22).
 */
export interface ProcessMirrorDeps {
  /** The friction dial — reads `mirror` instrument state. */
  readonly dial: { instrumentState(name: 'mirror'): MirrorState };
  /**
   * Returns the current transparency report (read-side computation over
   * the ledger). The mirror calls this on refresh — the caller is
   * responsible for debounce.
   */
  readonly report: () => Promise<TransparencyReport>;
  /**
   * Returns the chain integrity status from `Ledger.verify()`.
   */
  readonly verify: () => Promise<{ intact: boolean; brokenAt?: number }>;
}

// ---------------------------------------------------------------------------
// ProcessMirror — the main service
// ---------------------------------------------------------------------------

/**
 * The live process self-mirror. Reads the dial state, computes composition
 * proportions from the transparency report, and provides a `MirrorSnapshot`
 * that the TreeView renders.
 *
 *   - **hidden**: mirror is not visible; `snapshot()` returns minimal state.
 *   - **live**: mirror shows live composition + integrity.
 *
 * The mirror is read-only — it never writes to the ledger, never prompts
 * the writer, and never blocks writing. It is a self-awareness tool.
 */
export class ProcessMirror {
  constructor(private readonly deps: ProcessMirrorDeps) {}

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Whether the mirror is visible (dial-gated).
   */
  get visible(): boolean {
    return this.deps.dial.instrumentState('mirror') === 'live';
  }

  /**
   * The current dial state for the mirror.
   */
  get dialState(): MirrorState {
    return this.deps.dial.instrumentState('mirror');
  }

  /**
   * Compute the current mirror snapshot — composition + integrity.
   *
   * When the dial is "hidden", returns a minimal state with `visible: false`
   * and no composition data. When "live", reads the report and verify result.
   *
   * This is the primary method the TreeView calls on refresh. The caller
   * is responsible for debouncing — the mirror itself is synchronous once
   * the report/verify promises resolve.
   */
  async snapshot(): Promise<MirrorSnapshot> {
    if (!this.visible) {
      return {
        visible: false,
        composition: null,
        integrity: { intact: true },
      };
    }

    const [report, integrity] = await Promise.all([
      this.deps.report(),
      this.deps.verify(),
    ]);

    const composition = computeComposition(report.countsByType);

    return {
      visible: true,
      composition,
      integrity,
    };
  }

  /**
   * Format a composition snapshot as a human-readable summary line.
   * Used as the description for the root tree item.
   *
   * Mirror-not-grade: describes proportions without judgment.
   */
  static formatSummary(snapshot: CompositionSnapshot): string {
    const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
    return [
      `${LABELS.ownBursts}: ${pct(snapshot.ownBurstsRatio)}`,
      `${LABELS.pastedOrQuarantined}: ${pct(snapshot.pastedOrQuarantinedRatio)}`,
      `${LABELS.coachedOn}: ${pct(snapshot.coachedOnRatio)}`,
    ].join(' · ');
  }
}

// ---------------------------------------------------------------------------
// TreeView data provider — native sidebar view (ADR-007)
// ---------------------------------------------------------------------------

/**
 * TreeView data provider for the mirror sidebar view. Renders the mirror
 * state as a flat list of status items — composition proportions, integrity,
 * and a scoping note.
 *
 * This follows the same pattern as `LedgerTreeDataProvider` (task 17).
 * Requires `vscode` — only instantiated in the extension host.
 */

import * as vscode from 'vscode';

/** A single row in the process mirror tree. */
export class MirrorItem extends vscode.TreeItem {
  constructor(
    public readonly key: string,
    label: string,
    description: string,
    icon: vscode.ThemeIcon | undefined,
  ) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.description = description;
    this.contextValue = key;
    if (icon) {
      this.iconPath = icon;
    }
    this.accessibilityInformation = {
      label: `${label}: ${description}`,
      role: 'treeitem',
    };
  }
}

/**
 * TreeDataProvider for the process mirror sidebar view. Reads mirror state
 * and renders it as a flat list of items.
 *
 * The provider holds no business logic — it reads from a `MirrorSnapshot`
 * produced by `ProcessMirror.snapshot()`. The caller triggers
 * `refresh()` when the document changes (debounced).
 */
export class MirrorViewDataProvider implements vscode.TreeDataProvider<MirrorItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<MirrorItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private _state: MirrorSnapshot | null = null;

  /** Update the mirror state and refresh the view. */
  setState(state: MirrorSnapshot): void {
    this._state = state;
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Refresh the view (fire change event). */
  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: MirrorItem): vscode.TreeItem {
    return element;
  }

  getChildren(): MirrorItem[] {
    if (!this._state || !this._state.visible) {
      return [];
    }

    const items: MirrorItem[] = [];

    // Scoping note — always first
    items.push(
      new MirrorItem('scoping', LABELS.viewTitle, LABELS.scopingNote, new vscode.ThemeIcon('eye')),
    );

    // Composition
    if (this._state.composition) {
      const comp = this._state.composition;
      items.push(
        new MirrorItem(
          'own',
          LABELS.ownBursts,
          `${comp.ownBursts} (${Math.round(comp.ownBurstsRatio * 100)}%)`,
          new vscode.ThemeIcon('pencil'),
        ),
      );
      items.push(
        new MirrorItem(
          'pasted',
          LABELS.pastedOrQuarantined,
          `${comp.pastedOrQuarantined} (${Math.round(comp.pastedOrQuarantinedRatio * 100)}%)`,
          new vscode.ThemeIcon('clipboard'),
        ),
      );
      items.push(
        new MirrorItem(
          'coached',
          LABELS.coachedOn,
          `${comp.coachedOn} (${Math.round(comp.coachedOnRatio * 100)}%)`,
          new vscode.ThemeIcon('comment-discussion'),
        ),
      );
      items.push(
        new MirrorItem(
          'total',
          LABELS.totalEvents,
          `${comp.total}`,
          undefined,
        ),
      );
    } else {
      items.push(
        new MirrorItem('empty', 'Activity', LABELS.empty, new vscode.ThemeIcon('info')),
      );
    }

    // Integrity status
    const integrityDesc = this._state.integrity.intact
      ? 'Intact ✓'
      : `Broken at event ${this._state.integrity.brokenAt ?? 'unknown'}`;
    const integrityIcon = this._state.integrity.intact
      ? new vscode.ThemeIcon('check')
      : new vscode.ThemeIcon('warning');
    items.push(
      new MirrorItem('integrity', LABELS.integrity, integrityDesc, integrityIcon),
    );

    return items;
  }
}
