/**
 * Whetstone composer — app bootstrap (walking-skeleton, ADR-009).
 *
 * Wires the four slices: shell + journal, claim-first gate, paste-quarantine,
 * disclosure export. All record writes go through the `WhetstoneService` —
 * the client never stamps time or touches storage directly.
 */

import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { createQuarantine } from './editor/quarantine';
import { typingBurstExtension } from './editor/typingBurst';
import { LocalService } from './service/local';
import type { ProcessEventInput, WhetstoneService } from './service/types';
import { extractClaim } from './core/disclosure';
import { pinClaim, showClaimGate } from './ui/claimGate';
import { showDisclosure } from './ui/disclosurePanel';
import { JournalPanel } from './ui/journalPanel';
import './style.css';

const DOC_ID = location.hash.slice(1) || 'essay-1';

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header class="ws-header">
      <span class="ws-title">Whetstone</span>
      <div class="ws-claim-header" id="claim-header"></div>
      <button type="button" id="export-btn" class="ws-export">Export disclosure</button>
    </header>
    <main id="editor-host" class="ws-editor-host"></main>
    <footer id="journal-host" class="ws-footer"></footer>
  `;

  const service: WhetstoneService = new LocalService();
  const journalPanel = new JournalPanel(document.getElementById('journal-host')!);

  // Every journal write flows through the Service, which assigns id + ts.
  const emit = (e: ProcessEventInput): void => {
    void service.appendEvent(e).then((stamped) => journalPanel.append(stamped));
  };

  await service.startSession(DOC_ID);

  // Slice 2 — claim-first gate. A reload of a doc with a committed claim
  // resumes without re-gating (the ritual is per piece, not per visit).
  const claimHeader = document.getElementById('claim-header')!;
  const existingClaim = extractClaim(await service.getRecord(DOC_ID));
  let claim = existingClaim;
  if (!claim) {
    claim = await showClaimGate(app).claim;
    emit({ type: 'claim_set', size: claim.length, meta: { claim } });
  }
  pinClaim(claimHeader, claim);

  // Slices 1 + 3 — editor with typing bursts and paste-quarantine.
  const bursts = typingBurstExtension(emit);
  const quarantine = createQuarantine({ emit });

  const view = new EditorView({
    parent: document.getElementById('editor-host')!,
    state: EditorState.create({
      doc: '',
      extensions: [
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.lineWrapping,
        placeholder('Start drafting…'),
        bursts.extension,
        quarantine.extension,
      ],
    }),
  });
  view.focus();

  // Slice 4 — disclosure export.
  document.getElementById('export-btn')!.addEventListener('click', () => {
    bursts.tracker.flush(); // don't lose the trailing burst
    void service.exportDisclosure(DOC_ID).then((doc) => showDisclosure(doc, DOC_ID));
  });

  window.addEventListener('beforeunload', () => bursts.tracker.flush());
}

void boot();
