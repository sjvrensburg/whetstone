/**
 * Right rail — the unified assistant sidebar (Grammarly-style).
 *
 * One container, three tabbed panes: Coach (one-shot results + chat), the
 * live process Mirror, and the Journal. This module owns only the chrome
 * (tabs + pane hosts); the existing panel modules render into the hosts it
 * exposes, so their behaviour is unchanged.
 */

export type RailTab = 'coach' | 'mirror' | 'journal';

export interface RightRail {
  /** Host for one-shot coach results (renderCoachResult / teach-back bar). */
  coachResults: HTMLElement;
  /** Host for the coach chat panel. */
  chat: HTMLElement;
  /** Host for the MirrorPanel. */
  mirror: HTMLElement;
  /** Host for the JournalPanel. */
  journal: HTMLElement;
  /** Bring a tab to the front (e.g. when the coach produces a result). */
  show(tab: RailTab): void;
  /** Flag unseen activity on a tab the writer isn't currently viewing. */
  flag(tab: RailTab): void;
}

const TABS: { id: RailTab; label: string }[] = [
  { id: 'coach', label: 'Coach' },
  { id: 'mirror', label: 'Process' },
  { id: 'journal', label: 'Journal' },
];

export function createRightRail(host: HTMLElement): RightRail {
  host.classList.add('ws-rail');
  host.innerHTML = `
    <div class="ws-rail-tabs" role="tablist">
      ${TABS.map(
        (t) => `<button type="button" class="ws-rail-tab" role="tab" data-tab="${t.id}">
          <span class="ws-rail-tab-label">${t.label}</span>
          <span class="ws-rail-dot" hidden></span>
        </button>`,
      ).join('')}
    </div>
    <div class="ws-rail-panes">
      <section class="ws-rail-pane" data-pane="coach">
        <div class="ws-coach-results" id="coach-results"></div>
        <div class="ws-chat-host" id="chat-host"></div>
      </section>
      <section class="ws-rail-pane" data-pane="mirror">
        <div id="mirror-host"></div>
      </section>
      <section class="ws-rail-pane" data-pane="journal">
        <div id="journal-host"></div>
      </section>
    </div>
  `;

  const tabEls = new Map<RailTab, HTMLButtonElement>();
  const paneEls = new Map<RailTab, HTMLElement>();
  for (const t of TABS) {
    tabEls.set(t.id, host.querySelector(`.ws-rail-tab[data-tab="${t.id}"]`)!);
    paneEls.set(t.id, host.querySelector(`.ws-rail-pane[data-pane="${t.id}"]`)!);
  }

  let current: RailTab = 'coach';
  const show = (tab: RailTab): void => {
    current = tab;
    for (const t of TABS) {
      const active = t.id === tab;
      tabEls.get(t.id)!.classList.toggle('is-active', active);
      paneEls.get(t.id)!.classList.toggle('is-active', active);
      if (active) tabEls.get(t.id)!.querySelector('.ws-rail-dot')!.toggleAttribute('hidden', true);
    }
  };

  const flag = (tab: RailTab): void => {
    if (tab === current) return;
    tabEls.get(tab)!.querySelector('.ws-rail-dot')!.toggleAttribute('hidden', false);
  };

  for (const t of TABS) {
    tabEls.get(t.id)!.addEventListener('click', () => show(t.id));
  }
  show('coach');

  return {
    coachResults: host.querySelector('#coach-results')!,
    chat: host.querySelector('#chat-host')!,
    mirror: host.querySelector('#mirror-host')!,
    journal: host.querySelector('#journal-host')!,
    show,
    flag,
  };
}
