/**
 * Claim-first gate — instrument C (walking-skeleton spec §5).
 *
 * Before the editor is writable, a single required field: "In one sentence,
 * what are you arguing?" On submit the claim is journaled (`claim_set`),
 * pinned in a header, and the editor unlocks. The friction is the commitment
 * ritual — one field, fast.
 */

export interface ClaimGateElements {
  overlay: HTMLElement;
  input: HTMLInputElement;
}

/** Render the gate overlay into `host`; resolves with the submitted claim. */
export function showClaimGate(host: HTMLElement): { elements: ClaimGateElements; claim: Promise<string> } {
  const overlay = document.createElement('div');
  overlay.className = 'ws-claim-overlay';
  overlay.innerHTML = `
    <form class="ws-claim-form">
      <h2>Before you draft</h2>
      <label for="ws-claim-input">In one sentence, what are you arguing?</label>
      <input id="ws-claim-input" type="text" autocomplete="off"
             placeholder="My essay argues that…" required />
      <button type="submit">Start writing</button>
    </form>
  `;
  host.appendChild(overlay);

  const form = overlay.querySelector('form') as HTMLFormElement;
  const input = overlay.querySelector('input') as HTMLInputElement;
  input.focus();

  const claim = new Promise<string>((resolve) => {
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      const value = input.value.trim();
      if (value.length === 0) return;
      overlay.remove();
      resolve(value);
    });
  });

  return { elements: { overlay, input }, claim };
}

/** Pin the committed claim in the composer header. */
export function pinClaim(header: HTMLElement, claim: string): void {
  header.textContent = '';
  const label = document.createElement('span');
  label.className = 'ws-claim-label';
  label.textContent = 'Your claim: ';
  const text = document.createElement('span');
  text.className = 'ws-claim-text';
  text.textContent = claim;
  header.append(label, text);
  header.classList.add('ws-claim-pinned');
}
