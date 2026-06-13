/**
 * `brief/` — ~3-field writing brief capture via QuickInput + per-workspace
 * persistence (task 14, PRD F5, ADR-007).
 *
 * The brief is optional: coaching works fully without it. When present, it makes
 * coaching specific rather than generic. The capture flow is a multi-step
 * QuickInput where each field is individually skippable; the writer can also
 * cancel the entire flow.
 *
 * Persistence is per-workspace to `brief.json` with `updatedAt`. The storage
 * seam (`BriefStore`) is injected so the module stays headlessly unit-testable
 * (same DI pattern as `ConsentGate`, `LedgerImpl`, etc.).
 *
 * The coaching orchestrator (task 12) reads the brief via `read()` when present;
 * the UI (task 17) wires the real QuickInput prompter and registers the brief
 * edit command.
 */

import type { Brief } from '../shared/types';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// DI seams
// ---------------------------------------------------------------------------

/**
 * UI interaction seam for the multi-step QuickInput capture. The production
 * implementation wraps `vscode.window.showInputBox()`; tests inject a stub.
 */
export interface BriefPrompter {
  /**
   * Show one input step. Return the entered text, or `undefined` if the user
   * cancelled (Escape). An empty string means the field was skipped.
   */
  showInputStep(step: BriefInputStep): Promise<string | undefined>;
}

/** One step of the multi-step brief capture flow. */
export interface BriefInputStep {
  /** The step title shown in the QuickInput banner. */
  title: string;
  /** The explanatory prompt above the input box. */
  prompt: string;
  /** Placeholder text inside the input box. */
  placeholder: string;
  /** Pre-fill value when editing an existing brief. */
  value?: string;
}

/**
 * Persistence seam for `brief.json`. The production implementation writes to
 * the workspace-scoped storage directory; tests inject an in-memory stub.
 */
export interface BriefStore {
  /** Load the persisted brief, or `undefined` if none exists. */
  load(): Promise<Brief | undefined>;
  /** Persist a brief (create or overwrite). */
  save(brief: Brief): Promise<void>;
}

// ---------------------------------------------------------------------------
// Capture / edit result
// ---------------------------------------------------------------------------

/** The outcome of a brief capture or edit flow. */
export type CaptureResult = { ok: true; brief: Brief } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Field definitions
// ---------------------------------------------------------------------------

/** The three optional brief fields in capture order. */
const BRIEF_FIELDS = [
  {
    key: 'purposeClaim' as const,
    title: 'Writing Brief (1/3) — Purpose / Claim',
    prompt: 'What is the main purpose or claim of this piece?',
    placeholder: 'e.g., "Argue that LLMs should augment, not replace, peer review"',
  },
  {
    key: 'audienceVenue' as const,
    title: 'Writing Brief (2/3) — Audience / Venue',
    prompt: 'Who is the intended audience and where will this be published?',
    placeholder: 'e.g., "JAIS reviewers — information systems audience"',
  },
  {
    key: 'successCriterion' as const,
    title: 'Writing Brief (3/3) — Success Criterion',
    prompt: 'What does success look like for this piece?',
    placeholder: 'e.g., "Reviewers find the argument coherent and original"',
  },
] as const;

// ---------------------------------------------------------------------------
// File-based BriefStore
// ---------------------------------------------------------------------------

const BRIEF_FILE = 'brief.json';

/**
 * Validates that a parsed value has the shape of a `Brief`. Defensive — a
 * hand-edited `brief.json` might be malformed.
 */
function isValidBrief(data: unknown): data is Brief {
  if (typeof data !== 'object' || data === null) return false;
  const obj = data as Record<string, unknown>;
  if (typeof obj.updatedAt !== 'string') return false;
  if (obj.purposeClaim !== undefined && typeof obj.purposeClaim !== 'string') return false;
  if (obj.audienceVenue !== undefined && typeof obj.audienceVenue !== 'string') return false;
  if (obj.successCriterion !== undefined && typeof obj.successCriterion !== 'string') return false;
  return true;
}

/**
 * File-based `BriefStore` that reads/writes `brief.json` in a given directory.
 * Creates the directory on construction. Follows the same pattern as
 * `LedgerStore` (task 07).
 */
export class BriefFileStore implements BriefStore {
  private readonly filePath: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.filePath = join(dir, BRIEF_FILE);
  }

  /** The resolved file path (for testing / diagnostics). */
  get path(): string {
    return this.filePath;
  }

  async load(): Promise<Brief | undefined> {
    if (!existsSync(this.filePath)) return undefined;
    try {
      const raw = readFileSync(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      return isValidBrief(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  async save(brief: Brief): Promise<void> {
    writeFileSync(this.filePath, JSON.stringify(brief, null, 2), 'utf8');
  }
}

// ---------------------------------------------------------------------------
// BriefCapture — the main service
// ---------------------------------------------------------------------------

/**
 * The brief capture service. Orchestrates the multi-step QuickInput flow and
 * persists the result through the injected store. Follows the DI pattern of
 * `ConsentGate` (task 13): the prompter is injected so the module is
 * headlessly testable.
 */
export class BriefCapture {
  constructor(private readonly store: BriefStore) {}

  /**
   * Run the multi-step brief capture flow.
   *
   * Each of the three fields is shown as a separate input step. The user can:
   * - **Enter text** to set the field.
   * - **Leave empty and press Enter** to skip that field.
   * - **Press Escape** to cancel the entire flow.
   *
   * When the flow completes (all three steps shown), the brief is persisted
   * with the entered values and a fresh `updatedAt` timestamp. An all-skipped
   * brief is still persisted as a valid empty brief.
   *
   * @returns `{ ok: true, brief }` on completion, `{ ok: false, reason }` on cancel.
   */
  async capture(prompter: BriefPrompter): Promise<CaptureResult> {
    const existing = await this.store.load();

    const values: Partial<Pick<Brief, 'purposeClaim' | 'audienceVenue' | 'successCriterion'>> = {};

    for (const field of BRIEF_FIELDS) {
      const input = await prompter.showInputStep({
        title: field.title,
        prompt: field.prompt,
        placeholder: field.placeholder,
        value: existing?.[field.key],
      });

      // User pressed Escape — cancel the entire flow.
      if (input === undefined) {
        return { ok: false, reason: 'Brief capture cancelled.' };
      }

      // Non-empty input: store the trimmed value. Empty = skip.
      const trimmed = input.trim();
      if (trimmed.length > 0) {
        (values as Record<string, string>)[field.key] = trimmed;
      }
    }

    const brief: Brief = {
      ...values,
      updatedAt: new Date().toISOString(),
    };

    await this.store.save(brief);
    return { ok: true, brief };
  }

  /**
   * Read the current brief. Returns `undefined` if no brief has been captured
   * for this workspace. Coaching (task 12) reads the brief via this method
   * and includes it in the coaching request when present.
   */
  async read(): Promise<Brief | undefined> {
    return this.store.load();
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a `BriefCapture` backed by a file store in the given directory.
 * Convenience factory for the wiring layer (task 17).
 */
export function createBriefCapture(store: BriefStore): BriefCapture {
  return new BriefCapture(store);
}
