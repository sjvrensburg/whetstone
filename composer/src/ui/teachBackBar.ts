/**
 * Teach-back UI (slice 8): an inline, dismissible bar above the editor.
 * Never a modal, never blocking — the editor stays usable while it shows.
 */

import { DISCONNECT_NUDGE, TEACH_BACK_PROMPT } from '../instruments/teachBack';

/** Show the teach-back bar; resolves with the summary or undefined (skip). */
export function showTeachBackBar(host: HTMLElement): Promise<string | undefined> {
  host.querySelector('.ws-teachback')?.remove();

  const bar = document.createElement('form');
  bar.className = 'ws-teachback';
  bar.innerHTML = `
    <span class="ws-teachback-prompt"></span>
    <input type="text" autocomplete="off"
           placeholder='e.g. "So far I argue that…"' />
    <button type="submit">Done</button>
    <button type="button" class="ws-teachback-skip">Skip</button>
  `;
  (bar.querySelector('.ws-teachback-prompt') as HTMLElement).textContent = TEACH_BACK_PROMPT;
  host.prepend(bar);

  const input = bar.querySelector('input') as HTMLInputElement;

  return new Promise((resolve) => {
    const finish = (value: string | undefined) => {
      bar.remove();
      resolve(value);
    };
    (bar.querySelector('.ws-teachback-skip') as HTMLButtonElement).onclick = () =>
      finish(undefined);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') finish(undefined);
    });
    bar.addEventListener('submit', (ev) => {
      ev.preventDefault();
      finish(input.value);
    });
  });
}

/** Brief supportive nudge after a disconnect signal. */
export function showDisconnectNudge(host: HTMLElement): void {
  const note = document.createElement('div');
  note.className = 'ws-teachback-nudge';
  note.textContent = DISCONNECT_NUDGE;
  host.prepend(note);
  setTimeout(() => note.remove(), 8000);
}
