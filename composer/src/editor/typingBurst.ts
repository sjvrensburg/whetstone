/**
 * Process journal: typing bursts (walking-skeleton spec §5).
 *
 * Debounces typed input into bursts: a `typing_burst` event ({size, location})
 * is flushed after ~2s idle or N chars. METADATA ONLY — never the prose.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';
import type { ProcessEventInput } from '../service/types';

export const BURST_IDLE_MS = 2000;
export const BURST_MAX_CHARS = 200;

export type EmitEvent = (e: ProcessEventInput) => void;

/**
 * Accumulates typed characters into a burst and flushes on idle or size.
 * Pure of any editor dependency so it is directly testable; the CM extension
 * below feeds it.
 */
export class BurstTracker {
  private size = 0;
  private from = Number.POSITIVE_INFINITY;
  private to = Number.NEGATIVE_INFINITY;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: EmitEvent,
    private readonly idleMs: number = BURST_IDLE_MS,
    private readonly maxChars: number = BURST_MAX_CHARS,
  ) {}

  /** Record typed characters covering [from, to) in the current document. */
  record(chars: number, from: number, to: number): void {
    if (chars <= 0) return;
    this.size += chars;
    this.from = Math.min(this.from, from);
    this.to = Math.max(this.to, to);

    if (this.size >= this.maxChars) {
      this.flush();
      return;
    }

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), this.idleMs);
  }

  /** Flush the pending burst (if any) as a `typing_burst` event. */
  flush(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.size === 0) return;

    this.emit({
      type: 'typing_burst',
      size: this.size,
      location: { from: this.from, to: this.to },
    });

    this.size = 0;
    this.from = Number.POSITIVE_INFINITY;
    this.to = Number.NEGATIVE_INFINITY;
  }
}

/**
 * CodeMirror extension: feed typed (non-paste) input into a `BurstTracker`.
 * Returns the tracker too so callers can flush on session end/export.
 */
export function typingBurstExtension(emit: EmitEvent): {
  extension: Extension;
  tracker: BurstTracker;
} {
  const tracker = new BurstTracker(emit);

  const extension = EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;

    for (const tr of update.transactions) {
      // Pastes are journaled by the quarantine instrument; bursts cover typing.
      if (!tr.isUserEvent('input') || tr.isUserEvent('input.paste')) continue;

      tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
        if (inserted.length > 0) {
          tracker.record(inserted.length, fromB, toB);
        }
      });
    }
  });

  return { extension, tracker };
}
