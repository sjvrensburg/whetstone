/**
 * Whetstone composer — app bootstrap (walking-skeleton + slices 5/6, ADR-009).
 *
 * Wires the slices: shell + journal, claim-first gate, paste-quarantine,
 * disclosure export, coaching egress, live mirror. All record writes go
 * through the `WhetstoneService` — the client never stamps time or touches
 * storage directly.
 */

import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder } from '@codemirror/view';
import { WorkerLinter } from 'harper.js';
import { binary } from 'harper.js/binary';
import { extractClaim } from './core/disclosure';
import { computeMirror } from './core/mirror';
import { grammarExtension } from './editor/grammar';
import { idleObserver } from './editor/idle';
import { createQuarantine } from './editor/quarantine';
import { typingBurstExtension } from './editor/typingBurst';
import { harperBackend, type GrammarBackend } from './grammar/harper';
import { PushCadenceInstrument, extractParagraphs } from './instruments/pushCadence';
import { TeachBackInstrument } from './instruments/teachBack';
import { LocalService } from './service/local';
import {
  AnthropicCoachProvider,
  OpenAICompatibleCoachProvider,
  type CoachProvider,
} from './service/provider';
import type { ProcessEvent, ProcessEventInput, WhetstoneService } from './service/types';
import { pinClaim, showClaimGate } from './ui/claimGate';
import {
  loadCoachConfig,
  renderCoachResult,
  requestCoachConsent,
  type StoredCoachConfig,
} from './ui/coachPanel';
import { showDisclosure } from './ui/disclosurePanel';
import { JournalPanel } from './ui/journalPanel';
import { MirrorPanel } from './ui/mirrorPanel';
import { showDisconnectNudge, showTeachBackBar } from './ui/teachBackBar';
import './style.css';

const DOC_ID = location.hash.slice(1) || 'essay-1';

function providerFromConfig(config: StoredCoachConfig): CoachProvider {
  return config.provider === 'zai'
    ? new OpenAICompatibleCoachProvider({ apiKey: config.apiKey })
    : new AnthropicCoachProvider(config.apiKey);
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header class="ws-header">
      <span class="ws-title">Whetstone</span>
      <div class="ws-claim-header" id="claim-header"></div>
      <button type="button" id="coach-btn" class="ws-export">Coach</button>
      <button type="button" id="quiet-btn" class="ws-export" title="Silence proactive coaching for this session">Quiet</button>
      <button type="button" id="export-btn" class="ws-export">Export disclosure</button>
    </header>
    <main class="ws-main">
      <div id="editor-host" class="ws-editor-host"></div>
      <aside id="coach-host" class="ws-coach-host"></aside>
    </main>
    <footer class="ws-footer">
      <div id="mirror-host"></div>
      <div id="journal-host"></div>
    </footer>
  `;

  const localService = new LocalService();
  const service: WhetstoneService = localService;
  const journalPanel = new JournalPanel(document.getElementById('journal-host')!);
  const mirrorPanel = new MirrorPanel(document.getElementById('mirror-host')!);

  // The mirror reads the same journal the disclosure does — one source of truth.
  const journal: ProcessEvent[] = [];
  const onStamped = (stamped: ProcessEvent): void => {
    journal.push(stamped);
    journalPanel.append(stamped);
    mirrorPanel.update(computeMirror(journal));
  };

  // Every journal write flows through the Service, which assigns id + ts.
  const emit = (e: ProcessEventInput): void => {
    void service.appendEvent(e).then(onStamped);
  };

  await service.startSession(DOC_ID);
  journal.push(...(await service.getRecord(DOC_ID)));
  mirrorPanel.update(computeMirror(journal));

  // Restore a previously consented provider.
  const storedConfig = loadCoachConfig();
  if (storedConfig) localService.setProvider(providerFromConfig(storedConfig));

  // Slice 2 — claim-first gate. A reload of a doc with a committed claim
  // resumes without re-gating (the ritual is per piece, not per visit).
  const claimHeader = document.getElementById('claim-header')!;
  let claim = extractClaim(journal);
  if (!claim) {
    claim = await showClaimGate(app).claim;
    emit({ type: 'claim_set', size: claim.length, meta: { claim } });
  }
  pinClaim(claimHeader, claim);

  // Slice 7 — local grammar (Harper WASM, off the main thread). Setup runs in
  // the background; lints await it. Nothing leaves the device; nothing is
  // journaled (non-declarable local assistance).
  const harper = new WorkerLinter({ binary });
  const harperReady = harper.setup().catch((err) => {
    console.warn('Harper grammar unavailable:', err);
    throw err;
  });
  const inner = harperBackend(harper);
  const grammarBackend: GrammarBackend = {
    setup: () => harperReady,
    lint: async (text) => {
      await harperReady;
      return inner.lint(text);
    },
  };

  // Slices 8 + 9 — instruments D (teach-back) and A (push cadence) share one
  // idle boundary; teach-back wins the turn so the writer never gets two
  // interruptions at once.
  const coachHost = document.getElementById('coach-host')!;
  const teachBack = new TeachBackInstrument({
    emit,
    prompt: () => showTeachBackBar(coachHost),
  });
  const pushCadence = new PushCadenceInstrument({
    coach: (selectionText) => service.coach!({ selectionText, claim }),
    available: () => !!loadCoachConfig(),
    emit,
    now: () => Date.now(),
  });

  const onIdle = async (text: string): Promise<void> => {
    const tb = await teachBack.onIdle(extractParagraphs(text).length);
    if (tb.triggered) {
      if (tb.disconnect) showDisconnectNudge(coachHost);
      return; // one interruption per pause
    }
    const push = await pushCadence.onIdle();
    if (push.triggered) renderCoachResult(coachHost, push.result);
  };

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
        grammarExtension(grammarBackend),
        idleObserver({
          onChange: (text) => pushCadence.feedChange(text),
          onIdle: (text) => void onIdle(text),
        }),
      ],
    }),
  });
  view.focus();

  const quietBtn = document.getElementById('quiet-btn') as HTMLButtonElement;
  quietBtn.addEventListener('click', () => {
    if (pushCadence.isSilenced) {
      pushCadence.unsilenceSession();
      quietBtn.textContent = 'Quiet';
    } else {
      pushCadence.silenceSession();
      quietBtn.textContent = 'Quiet ✓';
    }
  });

  // Slice 4 — disclosure export.
  document.getElementById('export-btn')!.addEventListener('click', () => {
    bursts.tracker.flush(); // don't lose the trailing burst
    void service.exportDisclosure(DOC_ID).then((doc) => showDisclosure(doc, DOC_ID));
  });

  // Slice 5 — coaching on the current selection (or the whole draft).
  const coachBtn = document.getElementById('coach-btn') as HTMLButtonElement;
  coachBtn.addEventListener('click', async () => {
    if (!loadCoachConfig()) {
      const config = await requestCoachConsent();
      if (!config) return;
      localService.setProvider(providerFromConfig(config));
    }

    const sel = view.state.selection.main;
    const selectionText = sel.empty
      ? view.state.doc.toString()
      : view.state.doc.sliceString(sel.from, sel.to);
    if (selectionText.trim().length < 40) {
      coachHost.textContent = 'Write (or select) at least a few sentences to coach on.';
      return;
    }

    coachBtn.disabled = true;
    coachBtn.textContent = 'Coaching…';
    try {
      const result = await service.coach!({ selectionText, claim });
      renderCoachResult(coachHost, result);
    } finally {
      coachBtn.disabled = false;
      coachBtn.textContent = 'Coach';
    }
  });

  window.addEventListener('beforeunload', () => bursts.tracker.flush());
}

void boot();
