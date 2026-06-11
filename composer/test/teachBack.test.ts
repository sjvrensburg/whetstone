import { describe, expect, it } from 'vitest';
import {
  TeachBackInstrument,
  classifyTeachBack,
  isDisconnect,
  TEACH_BACK_PROMPT,
  DISCONNECT_NUDGE,
} from '../src/instruments/teachBack';
import { hasNoForbiddenLabels } from '../src/core/labels';
import type { ProcessEventInput } from '../src/service/types';

describe('isDisconnect / classifyTeachBack', () => {
  it('flags empty, too-short, and placeholder answers', () => {
    for (const text of ['', '   ', 'short', 'idk', "I don't know", 'n/a', 'none', '...', '---']) {
      expect(isDisconnect(text), `"${text}"`).toBe(true);
    }
  });

  it('accepts a real one-line summary', () => {
    expect(isDisconnect('This section argues the sample size must be justified.')).toBe(false);
  });

  it('classifies dismissal as skipped (not a disconnect)', () => {
    expect(classifyTeachBack(undefined)).toEqual({ outcome: 'skipped', disconnect: false });
    expect(classifyTeachBack('idk')).toEqual({ outcome: 'disconnect-flagged', disconnect: true });
    expect(classifyTeachBack('I argue that friction beats detection.')).toEqual({
      outcome: 'given',
      disconnect: false,
    });
  });

  it('prompt copy passes the forbidden-label guard', () => {
    expect(hasNoForbiddenLabels(TEACH_BACK_PROMPT)).toBe(true);
    expect(hasNoForbiddenLabels(DISCONNECT_NUDGE)).toBe(true);
  });
});

describe('TeachBackInstrument', () => {
  function setup(answers: (string | undefined)[]) {
    const events: ProcessEventInput[] = [];
    const prompts: number[] = [];
    const instrument = new TeachBackInstrument({
      emit: (e) => events.push(e),
      prompt: async () => {
        prompts.push(1);
        return answers.shift();
      },
      every: 3,
    });
    return { events, prompts, instrument };
  }

  it('checkpoints after every 3rd new paragraph', async () => {
    const { instrument, prompts, events } = setup(['My argument so far is that X causes Y.']);

    expect((await instrument.onIdle(1)).triggered).toBe(false);
    expect((await instrument.onIdle(2)).triggered).toBe(false);
    const result = await instrument.onIdle(3);
    expect(result).toMatchObject({ triggered: true, outcome: 'given', disconnect: false });
    expect(prompts).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'teach_back', meta: { outcome: 'given' } });
  });

  it('never journals the summary prose — size only', async () => {
    const { instrument, events } = setup(['A perfectly articulate summary of my argument.']);
    await instrument.onIdle(3);
    const json = JSON.stringify(events);
    expect(json).not.toContain('articulate summary');
    expect(events[0].size).toBe('A perfectly articulate summary of my argument.'.length);
  });

  it('journals a skipped outcome when dismissed and keeps counting', async () => {
    const { instrument, events } = setup([undefined, 'Now I can say it: X beats Y on cost.']);
    await instrument.onIdle(3);
    expect(events[0].meta).toMatchObject({ outcome: 'skipped', disconnect: false });

    // Counter reset after the checkpoint: three MORE paragraphs re-trigger.
    expect((await instrument.onIdle(5)).triggered).toBe(false);
    const second = await instrument.onIdle(6);
    expect(second).toMatchObject({ triggered: true, outcome: 'given' });
  });

  it('flags disconnects', async () => {
    const { instrument, events } = setup(['idk']);
    const result = await instrument.onIdle(3);
    expect(result).toMatchObject({ triggered: true, disconnect: true });
    expect(events[0].meta).toMatchObject({ outcome: 'disconnect-flagged', disconnect: true });
  });

  it('does not double-prompt while a prompt is open', async () => {
    let resolvePrompt!: (v: string | undefined) => void;
    const events: ProcessEventInput[] = [];
    let promptCount = 0;
    const instrument = new TeachBackInstrument({
      emit: (e) => events.push(e),
      prompt: () =>
        new Promise((resolve) => {
          promptCount++;
          resolvePrompt = resolve;
        }),
      every: 1,
    });

    const first = instrument.onIdle(1);
    expect((await instrument.onIdle(2)).triggered).toBe(false); // prompt still open
    resolvePrompt('My one-line argument summary here.');
    await first;
    expect(promptCount).toBe(1);
  });
});
