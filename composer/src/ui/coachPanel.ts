/**
 * Coaching UI (slice 5): the consent + key dialog (first use) and the
 * observations panel. Consent is explicit and informed — the dialog states
 * exactly what leaves the device, to whom, and what is journaled.
 */

import type { CoachResult } from '../service/types';

const KEY_STORAGE = 'whetstone.coach';

export interface StoredCoachConfig {
  provider: 'anthropic' | 'zai';
  apiKey: string;
  consentedAt: string;
}

export function loadCoachConfig(): StoredCoachConfig | null {
  try {
    const raw = localStorage.getItem(KEY_STORAGE);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredCoachConfig;
    if (!parsed.apiKey || !parsed.consentedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearCoachConfig(): void {
  localStorage.removeItem(KEY_STORAGE);
}

/**
 * First-use consent + key dialog. Resolves with the stored config, or null
 * if the writer declines. Nothing leaves the device until this resolves.
 */
export function requestCoachConsent(): Promise<StoredCoachConfig | null> {
  document.querySelector('.ws-consent-modal')?.remove();

  const modal = document.createElement('div');
  modal.className = 'ws-consent-modal';
  modal.innerHTML = `
    <form class="ws-consent-card">
      <h2>Before coaching can run</h2>
      <p>Coaching sends <strong>your selected passage and your stated claim</strong> to an
      AI provider using <strong>your own API key</strong>. Nothing else is sent, and nothing
      is sent until you ask for coaching. The process journal records only metadata
      (provider, model, selection size) — never the text.</p>
      <p>Coaching returns structural observations and questions. It never writes or
      rewrites prose; responses that try are refused.</p>
      <label>Provider
        <select name="provider">
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="zai">Z.ai (GLM)</option>
        </select>
      </label>
      <label>Your API key
        <input name="key" type="password" autocomplete="off" required
               placeholder="stored only in this browser" />
      </label>
      <div class="ws-consent-actions">
        <button type="submit">I consent — enable coaching</button>
        <button type="button" class="ws-consent-cancel">Not now</button>
      </div>
    </form>
  `;
  document.body.appendChild(modal);

  const form = modal.querySelector('form') as HTMLFormElement;
  (modal.querySelector('input[name=key]') as HTMLInputElement).focus();

  return new Promise((resolve) => {
    (modal.querySelector('.ws-consent-cancel') as HTMLButtonElement).onclick = () => {
      modal.remove();
      resolve(null);
    };
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const data = new FormData(form);
      const config: StoredCoachConfig = {
        provider: data.get('provider') === 'zai' ? 'zai' : 'anthropic',
        apiKey: String(data.get('key') ?? '').trim(),
        consentedAt: new Date().toISOString(),
      };
      if (!config.apiKey) return;
      localStorage.setItem(KEY_STORAGE, JSON.stringify(config));
      modal.remove();
      resolve(config);
    });
  });
}

const KIND_LABELS: Record<string, string> = {
  implicit_claim: 'Implicit claim',
  intended_move: 'Intended move',
  logic_fork: 'Logic fork',
};

/** Render a coaching result into the side panel. */
export function renderCoachResult(host: HTMLElement, result: CoachResult): void {
  host.innerHTML = '';
  const panel = document.createElement('div');
  panel.className = 'ws-coach-panel';

  if (!result.ok) {
    panel.innerHTML = `
      <h3>Coaching withheld</h3>
      <p class="ws-coach-refusal">The ${result.layer === 'provider' ? 'provider call failed' : `${result.layer} guard refused the response`}:
      <em></em></p>
      <p>Nothing was shown because the response did not meet the no-prose rules.</p>
    `;
    (panel.querySelector('em') as HTMLElement).textContent = result.reason;
    host.appendChild(panel);
    return;
  }

  const heading = document.createElement('h3');
  heading.textContent = `Coaching (${result.observations.length} observation${result.observations.length === 1 ? '' : 's'})`;
  panel.appendChild(heading);

  for (const obs of result.observations) {
    const card = document.createElement('div');
    card.className = 'ws-coach-card';
    const kind = document.createElement('span');
    kind.className = 'ws-coach-kind';
    kind.textContent = KIND_LABELS[obs.kind] ?? obs.kind;
    const reflection = document.createElement('p');
    reflection.textContent = obs.reflection;
    const question = document.createElement('p');
    question.className = 'ws-coach-question';
    question.textContent = obs.question;
    card.append(kind, reflection, question);
    panel.appendChild(card);
  }

  const note = document.createElement('p');
  note.className = 'ws-coach-note';
  note.textContent = 'Questions to think with — the writing stays yours.';
  panel.appendChild(note);

  host.appendChild(panel);
}
