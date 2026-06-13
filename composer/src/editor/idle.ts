/**
 * Idle observer: notifies instruments when the writer pauses after edits.
 * Instruments A and D both key off "the writer finished something and
 * stopped" — one timer serves both.
 */

import { EditorView } from '@codemirror/view';
import type { Extension } from '@codemirror/state';

export const IDLE_MS = 4000;

export interface IdleObserverOptions {
  /** Called on every doc change with the full text. */
  onChange?: (text: string) => void;
  /** Called once after `idleMs` of no edits, with the settled text. */
  onIdle: (text: string) => void;
  idleMs?: number;
}

export function idleObserver(options: IdleObserverOptions): Extension {
  const idleMs = options.idleMs ?? IDLE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;

  return EditorView.updateListener.of((update) => {
    if (!update.docChanged) return;
    const text = update.state.doc.toString();
    options.onChange?.(text);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      options.onIdle(text);
    }, idleMs);
  });
}
