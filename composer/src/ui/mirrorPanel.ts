/**
 * Live process mirror panel (slice 6, instrument E) — a single line above the
 * journal that reflects the session's composition as it evolves. Read-only;
 * mirror, not grade.
 */

import { formatMirrorSummary, MIRROR_LABELS, type MirrorSnapshot } from '../core/mirror';

export class MirrorPanel {
  private readonly summary: HTMLElement;

  constructor(host: HTMLElement) {
    const bar = document.createElement('div');
    bar.className = 'ws-mirror';
    bar.title = MIRROR_LABELS.scopingNote;
    bar.innerHTML = `<span class="ws-mirror-summary"></span>`;
    host.appendChild(bar);
    this.summary = bar.querySelector('.ws-mirror-summary') as HTMLElement;
    this.summary.textContent = 'Start writing to see your process here.';
  }

  update(snapshot: MirrorSnapshot): void {
    if (snapshot.composition.typedChars + snapshot.composition.pastedChars === 0) return;
    this.summary.textContent = formatMirrorSummary(snapshot);
  }
}
