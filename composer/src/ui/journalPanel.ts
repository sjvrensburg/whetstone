/**
 * Debug journal panel (slice 1) — a live, collapsible list of process events
 * as they land in the Service. Development affordance; metadata only.
 */

import type { ProcessEvent } from '../service/types';

export class JournalPanel {
  private list: HTMLElement;
  private count: HTMLElement;
  private total = 0;

  constructor(host: HTMLElement) {
    const details = document.createElement('details');
    details.className = 'ws-journal';
    details.innerHTML = `
      <summary>Process journal (<span class="ws-journal-count">0</span> events)</summary>
      <ol class="ws-journal-list" reversed></ol>
    `;
    host.appendChild(details);
    this.list = details.querySelector('.ws-journal-list') as HTMLElement;
    this.count = details.querySelector('.ws-journal-count') as HTMLElement;
  }

  append(event: ProcessEvent): void {
    this.total++;
    this.count.textContent = String(this.total);

    const li = document.createElement('li');
    const parts = [event.ts.slice(11, 19), event.type];
    if (event.size !== undefined) parts.push(`size=${event.size}`);
    if (event.location) parts.push(`@${event.location.from}–${event.location.to}`);
    if (event.meta) {
      for (const [k, v] of Object.entries(event.meta)) {
        const shown = typeof v === 'string' && v.length > 24 ? `${v.slice(0, 24)}…` : v;
        parts.push(`${k}=${shown}`);
      }
    }
    li.textContent = parts.join(' · ');
    this.list.prepend(li);

    // Keep the debug panel bounded.
    while (this.list.children.length > 200) {
      this.list.lastElementChild?.remove();
    }
  }
}
