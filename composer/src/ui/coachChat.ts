/**
 * Coach chat box: a conversational channel with the coach in the sidebar.
 * The conversation lives in this session only — it is never journaled and
 * never persisted; the journal records metadata-only coach_consult events.
 */

import type { ChatTurn } from '../core/prompts';
import type { ChatResult } from '../service/types';

export type SendChat = (message: string, history: ChatTurn[]) => Promise<ChatResult>;

export class CoachChatPanel {
  private readonly history: ChatTurn[] = [];
  private readonly list: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;

  constructor(
    host: HTMLElement,
    private readonly send: SendChat,
    private readonly ensureReady: () => Promise<boolean>,
  ) {
    const box = document.createElement('div');
    box.className = 'ws-chat';
    box.innerHTML = `
      <h3>Ask the coach</h3>
      <div class="ws-chat-list"></div>
      <form class="ws-chat-form">
        <textarea rows="2" placeholder="Ask about your argument — the coach won't write it for you."></textarea>
        <button type="submit">Send</button>
      </form>
    `;
    host.appendChild(box);

    this.list = box.querySelector('.ws-chat-list') as HTMLElement;
    this.input = box.querySelector('textarea') as HTMLTextAreaElement;
    this.sendBtn = box.querySelector('button') as HTMLButtonElement;

    const form = box.querySelector('form') as HTMLFormElement;
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.submit();
    });
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        void this.submit();
      }
    });
  }

  private addBubble(role: 'writer' | 'coach' | 'system', text: string): HTMLElement {
    const bubble = document.createElement('div');
    bubble.className = `ws-chat-msg ws-chat-${role}`;
    bubble.textContent = text;
    this.list.appendChild(bubble);
    this.list.scrollTop = this.list.scrollHeight;
    return bubble;
  }

  private async submit(): Promise<void> {
    const message = this.input.value.trim();
    if (message.length === 0 || this.sendBtn.disabled) return;

    if (!(await this.ensureReady())) return;

    this.input.value = '';
    this.addBubble('writer', message);
    const thinking = this.addBubble('coach', '…');
    this.sendBtn.disabled = true;

    try {
      const result = await this.send(message, [...this.history]);
      if (result.ok) {
        thinking.textContent = result.reply;
        this.history.push({ role: 'writer', text: message }, { role: 'coach', text: result.reply });
        // Bound the context we resend each turn.
        while (this.history.length > 12) this.history.shift();
      } else {
        thinking.classList.add('ws-chat-refused');
        thinking.textContent =
          result.layer === 'provider'
            ? `The provider call failed: ${result.reason}`
            : 'The coach started writing prose for you, so the reply was withheld. Try asking about your argument instead.';
      }
    } finally {
      this.sendBtn.disabled = false;
      this.input.focus();
    }
  }
}
