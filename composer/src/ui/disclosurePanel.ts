/**
 * Disclosure export panel (slice 4) — generate, view, copy, and download the
 * "how this was written" document.
 */

import type { DisclosureDoc } from '../service/types';

export function showDisclosure(doc: DisclosureDoc, docId: string): void {
  document.querySelector('.ws-disclosure-modal')?.remove();

  const modal = document.createElement('div');
  modal.className = 'ws-disclosure-modal';
  modal.innerHTML = `
    <div class="ws-disclosure-card">
      <h2>How this was written</h2>
      <pre class="ws-disclosure-body"></pre>
      <div class="ws-disclosure-actions">
        <button type="button" class="ws-copy">Copy</button>
        <button type="button" class="ws-download">Download</button>
        <button type="button" class="ws-close">Close</button>
      </div>
    </div>
  `;
  (modal.querySelector('.ws-disclosure-body') as HTMLElement).textContent = doc.markdown;

  (modal.querySelector('.ws-copy') as HTMLButtonElement).onclick = async (ev) => {
    await navigator.clipboard.writeText(doc.markdown);
    (ev.target as HTMLButtonElement).textContent = 'Copied ✓';
  };

  (modal.querySelector('.ws-download') as HTMLButtonElement).onclick = () => {
    const blob = new Blob([doc.markdown], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${docId}-disclosure.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  (modal.querySelector('.ws-close') as HTMLButtonElement).onclick = () => modal.remove();

  document.body.appendChild(modal);
}
