/**
 * Whetstone composer — app bootstrap (walking-skeleton + slices 5/6, ADR-009).
 *
 * Two layers:
 *   boot()          — one-time shell: document sidebar, topbar, right rail,
 *                     the shared Harper linter, the Service, and the local
 *                     DraftStore. Built once.
 *   openDocument()  — per-document lifecycle: tears down the previous editor
 *                     and rebuilds the session (editor, instruments, journal,
 *                     claim) for the opened doc. This is what makes switching,
 *                     creating, and deleting documents work.
 *
 * Provenance (the journal) flows through `WhetstoneService`, which assigns
 * event id + ts — the client never stamps time or touches that storage.
 * Draft PROSE is persisted separately, in `DraftStore`, which is local-only
 * and never crosses the witness seam (see draftStore.ts).
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
import { DraftStore } from './service/draftStore';
import { LocalService } from './service/local';
import {
  AnthropicCoachProvider,
  OpenAICompatibleCoachProvider,
  type CoachProvider,
} from './service/provider';
import type { ProcessEvent, ProcessEventInput, WhetstoneService } from './service/types';
import { pinClaim, showClaimGate } from './ui/claimGate';
import { CoachChatPanel } from './ui/coachChat';
import {
  loadCoachConfig,
  renderCoachResult,
  requestCoachConsent,
  type StoredCoachConfig,
} from './ui/coachPanel';
import { showDisclosure } from './ui/disclosurePanel';
import { DocSidebar } from './ui/docSidebar';
import { JournalPanel } from './ui/journalPanel';
import { MirrorPanel } from './ui/mirrorPanel';
import { createRightRail } from './ui/rightRail';
import { showDisconnectNudge, showTeachBackBar } from './ui/teachBackBar';
import './style.css';

const AUTOSAVE_MS = 700;

function providerFromConfig(config: StoredCoachConfig): CoachProvider {
  return config.provider === 'zai'
    ? new OpenAICompatibleCoachProvider({ apiKey: config.apiKey })
    : new AnthropicCoachProvider(config.apiKey);
}

/** Everything the shell-level buttons need from the currently open document. */
interface ActiveSession {
  docId: string;
  claim: string;
  view: EditorView;
  bursts: ReturnType<typeof typingBurstExtension>;
  pushCadence: PushCadenceInstrument;
  /** Persist the current prose now (used on switch / unload). */
  flushSave: () => Promise<void>;
}

async function boot(): Promise<void> {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <header class="ws-header">
      <span class="ws-brand">Whetstone</span>
      <input type="text" id="doc-title" class="ws-doc-title" aria-label="Document title"
             placeholder="Untitled document" />
      <span id="save-state" class="ws-save-state"></span>
      <div class="ws-header-spacer"></div>
      <button type="button" id="coach-btn" class="ws-btn ws-btn-primary">Coach</button>
      <button type="button" id="quiet-btn" class="ws-btn" title="Silence proactive coaching for this session">Quiet</button>
      <button type="button" id="export-btn" class="ws-btn">Export disclosure</button>
    </header>
    <div class="ws-body">
      <nav id="sidebar-host"></nav>
      <main class="ws-main">
        <div class="ws-claim-line" id="claim-line"></div>
        <div id="editor-host" class="ws-editor-host"></div>
      </main>
      <aside id="rail-host"></aside>
    </div>
  `;

  // --- Shared, one-time infrastructure -------------------------------------

  const drafts = new DraftStore();
  const localService = new LocalService();
  const service: WhetstoneService = localService;

  // Restore a previously consented coaching provider (shared across docs).
  const storedConfig = loadCoachConfig();
  if (storedConfig) localService.setProvider(providerFromConfig(storedConfig));

  // Harper WASM linter — expensive to spin up, so do it once and share the
  // backend across every document's editor. Nothing leaves the device.
  const harper = new WorkerLinter({ binary });
  const harperReady = harper.setup().catch((err) => {
    console.warn('Harper grammar unavailable:', err);
    throw err;
  });
  const harperInner = harperBackend(harper);
  const grammarBackend: GrammarBackend = {
    setup: () => harperReady,
    lint: async (text) => {
      await harperReady;
      return harperInner.lint(text);
    },
  };

  const rail = createRightRail(document.getElementById('rail-host')!);
  const titleInput = document.getElementById('doc-title') as HTMLInputElement;
  const saveState = document.getElementById('save-state')!;
  const claimLine = document.getElementById('claim-line')!;
  const editorHost = document.getElementById('editor-host')!;

  let active: ActiveSession | null = null;

  // --- Shell-level button wiring (reads from `active`) ----------------------

  const ensureCoachConfigured = async (): Promise<boolean> => {
    if (loadCoachConfig()) return true;
    const config = await requestCoachConsent();
    if (!config) return false;
    localService.setProvider(providerFromConfig(config));
    return true;
  };

  const coachBtn = document.getElementById('coach-btn') as HTMLButtonElement;
  coachBtn.addEventListener('click', async () => {
    if (!active || !(await ensureCoachConfigured())) return;
    const { view, claim } = active;
    const sel = view.state.selection.main;
    const selectionText = sel.empty
      ? view.state.doc.toString()
      : view.state.doc.sliceString(sel.from, sel.to);
    if (selectionText.trim().length < 40) {
      rail.show('coach');
      rail.coachResults.textContent = 'Write (or select) at least a few sentences to coach on.';
      return;
    }
    coachBtn.disabled = true;
    coachBtn.textContent = 'Coaching…';
    try {
      const result = await service.coach!({ selectionText, claim });
      renderCoachResult(rail.coachResults, result);
      rail.show('coach');
    } finally {
      coachBtn.disabled = false;
      coachBtn.textContent = 'Coach';
    }
  });

  const quietBtn = document.getElementById('quiet-btn') as HTMLButtonElement;
  quietBtn.addEventListener('click', () => {
    if (!active) return;
    const pc = active.pushCadence;
    if (pc.isSilenced) {
      pc.unsilenceSession();
      quietBtn.textContent = 'Quiet';
    } else {
      pc.silenceSession();
      quietBtn.textContent = 'Quiet ✓';
    }
  });

  document.getElementById('export-btn')!.addEventListener('click', () => {
    if (!active) return;
    active.bursts.tracker.flush(); // don't lose the trailing burst
    void service.exportDisclosure(active.docId).then((doc) => showDisclosure(doc, active!.docId));
  });

  // --- Document management --------------------------------------------------

  const sidebar = new DocSidebar(document.getElementById('sidebar-host')!, {
    store: drafts,
    activeId: () => active?.docId ?? null,
    onOpen: (id) => void openDocument(id),
    onCreate: () => void createAndOpen(),
    onDelete: (id) => void deleteDocument(id),
  });

  async function createAndOpen(): Promise<void> {
    const doc = await drafts.create();
    await openDocument(doc.id);
  }

  async function deleteDocument(id: string): Promise<void> {
    await drafts.delete(id);
    if (active?.docId === id) {
      active = null;
      const remaining = await drafts.list();
      const next = remaining[0]?.id ?? (await drafts.create()).id;
      await openDocument(next);
    } else {
      await sidebar.refresh();
    }
  }

  // --- Per-document lifecycle ----------------------------------------------

  async function openDocument(docId: string): Promise<void> {
    // Tear down the previous session: flush its trailing burst and persist its
    // prose BEFORE the Service switches docs, so neither lands on the new doc.
    if (active) {
      active.bursts.tracker.flush();
      await active.flushSave();
      active.view.destroy();
      active = null;
    }

    const draft = (await drafts.get(docId)) ?? (await drafts.create());
    location.hash = draft.id;

    await service.startSession(draft.id);
    const journal: ProcessEvent[] = await service.getRecord(draft.id);

    // Rebuild the right-rail journal + mirror for this document.
    rail.journal.replaceChildren();
    rail.mirror.replaceChildren();
    rail.coachResults.replaceChildren();
    const journalPanel = new JournalPanel(rail.journal);
    const mirrorPanel = new MirrorPanel(rail.mirror);
    for (const e of journal) journalPanel.append(e);
    mirrorPanel.update(computeMirror(journal));

    const onStamped = (stamped: ProcessEvent): void => {
      journal.push(stamped);
      journalPanel.append(stamped);
      mirrorPanel.update(computeMirror(journal));
      rail.flag('journal');
    };
    const emit = (e: ProcessEventInput): void => {
      void service.appendEvent(e).then(onStamped);
    };

    // Claim-first gate (instrument C). A doc that already committed a claim
    // resumes without re-gating — the ritual is per piece, not per visit.
    let claim = extractClaim(journal);
    if (!claim) {
      claim = await showClaimGate(app).claim;
      emit({ type: 'claim_set', size: claim.length, meta: { claim } });
    }
    pinClaim(claimLine, claim);

    // Title field reflects this document; edits rename it.
    titleInput.value = draft.title;

    // Instruments D (teach-back) + A (push cadence) share the idle boundary;
    // teach-back wins so the writer never gets two interruptions at once.
    const teachBack = new TeachBackInstrument({
      emit,
      prompt: () => showTeachBackBar(rail.coachResults),
    });
    const pushCadence = new PushCadenceInstrument({
      coach: (selectionText) => service.coach!({ selectionText, claim }),
      available: () => !!loadCoachConfig(),
      emit,
      now: () => Date.now(),
    });
    quietBtn.textContent = pushCadence.isSilenced ? 'Quiet ✓' : 'Quiet';

    const onIdle = async (text: string): Promise<void> => {
      const tb = await teachBack.onIdle(extractParagraphs(text).length);
      if (tb.triggered) {
        if (tb.disconnect) showDisconnectNudge(rail.coachResults);
        rail.flag('coach');
        return; // one interruption per pause
      }
      const push = await pushCadence.onIdle();
      if (push.triggered) {
        renderCoachResult(rail.coachResults, push.result);
        rail.flag('coach');
      }
    };

    // Autosave: debounce prose writes to the local DraftStore.
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let pending = false;
    const doSave = async (): Promise<void> => {
      pending = false;
      await drafts.saveContent(docId, view.state.doc.toString());
      saveState.textContent = 'Saved';
      void sidebar.refresh();
    };
    const flushSave = async (): Promise<void> => {
      if (saveTimer) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (pending) await doSave();
    };
    const scheduleSave = (): void => {
      pending = true;
      saveState.textContent = 'Saving…';
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => void doSave(), AUTOSAVE_MS);
    };

    // Editor: typing bursts + paste-quarantine + grammar + idle instruments +
    // autosave. Seeded with the restored prose — initial state isn't an
    // update, so it is NOT mis-journaled as typing or a paste.
    const bursts = typingBurstExtension(emit);
    const quarantine = createQuarantine({ emit });
    const view = new EditorView({
      parent: editorHost,
      state: EditorState.create({
        doc: draft.content,
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
          EditorView.updateListener.of((u) => {
            if (u.docChanged) scheduleSave();
          }),
        ],
      }),
    });
    saveState.textContent = 'Saved';
    view.focus();

    // Coach chat — same guard + journal rules as one-shot coaching. Context is
    // the selection, else the draft tail.
    const chatContext = (): string => {
      const sel = view.state.selection.main;
      if (!sel.empty) return view.state.doc.sliceString(sel.from, sel.to);
      return view.state.doc.toString().slice(-2000);
    };
    rail.chat.replaceChildren();
    new CoachChatPanel(
      rail.chat,
      (message, hist) => service.coachChat!({ message, history: hist, contextText: chatContext(), claim }),
      ensureCoachConfigured,
    );

    active = { docId, claim, view, bursts, pushCadence, flushSave };
    await sidebar.refresh();
  }

  // Title editing renames the active document.
  const commitTitle = (): void => {
    if (!active) return;
    void drafts.setTitle(active.docId, titleInput.value).then(() => sidebar.refresh());
  };
  titleInput.addEventListener('blur', commitTitle);
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      titleInput.blur();
    }
  });

  window.addEventListener('beforeunload', () => {
    active?.bursts.tracker.flush();
    void active?.flushSave();
  });

  // --- Initial document ----------------------------------------------------

  const existing = await drafts.list();
  const hashId = location.hash.slice(1);
  const initialId =
    (hashId && existing.some((d) => d.id === hashId) && hashId) ||
    existing[0]?.id ||
    (await drafts.create()).id;
  await openDocument(initialId);
}

void boot();
