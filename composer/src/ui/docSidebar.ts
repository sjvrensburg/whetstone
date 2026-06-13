/**
 * Document sidebar — the left rail (Grammarly-style document list).
 *
 * Lists every local draft, lets the writer create a new one, switch between
 * them, or delete one. Pure DOM; all persistence goes through `DraftStore`.
 * The sidebar never holds prose — it renders `DocMeta` only.
 */

import type { DocMeta, DraftStore } from '../service/draftStore';

export interface DocSidebarOptions {
  store: DraftStore;
  /** The doc to highlight as active. */
  activeId: () => string | null;
  /** Open (switch to) a document. */
  onOpen: (id: string) => void;
  /** Create a new document, then open it. */
  onCreate: () => void;
  /** Delete a document. The caller decides what to open next. */
  onDelete: (id: string) => void;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export class DocSidebar {
  private listEl: HTMLElement;

  constructor(
    private readonly host: HTMLElement,
    private readonly opts: DocSidebarOptions,
  ) {
    this.host.classList.add('ws-sidebar');
    this.host.innerHTML = `
      <div class="ws-sidebar-head">
        <span class="ws-sidebar-title">Documents</span>
        <button type="button" class="ws-newdoc" title="New document">+ New</button>
      </div>
      <ul class="ws-doclist" role="listbox"></ul>
    `;
    this.listEl = this.host.querySelector('.ws-doclist')!;
    this.host.querySelector('.ws-newdoc')!.addEventListener('click', () => this.opts.onCreate());
  }

  async refresh(): Promise<void> {
    const docs = await this.opts.store.list();
    const active = this.opts.activeId();
    this.listEl.replaceChildren(...docs.map((d) => this.renderItem(d, d.id === active)));
  }

  private renderItem(doc: DocMeta, isActive: boolean): HTMLLIElement {
    const li = document.createElement('li');
    li.className = 'ws-docitem' + (isActive ? ' is-active' : '');
    li.setAttribute('role', 'option');
    li.setAttribute('aria-selected', String(isActive));

    const main = document.createElement('button');
    main.type = 'button';
    main.className = 'ws-docitem-main';
    main.innerHTML = `
      <span class="ws-docitem-title"></span>
      <span class="ws-docitem-time"></span>
    `;
    main.querySelector('.ws-docitem-title')!.textContent = doc.title;
    main.querySelector('.ws-docitem-time')!.textContent = relativeTime(doc.updatedAt);
    main.addEventListener('click', () => this.opts.onOpen(doc.id));

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'ws-docitem-del';
    del.title = 'Delete document';
    del.setAttribute('aria-label', `Delete ${doc.title}`);
    del.textContent = '×';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm(`Delete “${doc.title}”? This removes the draft and its process record.`)) {
        this.opts.onDelete(doc.id);
      }
    });

    li.append(main, del);
    return li;
  }
}
