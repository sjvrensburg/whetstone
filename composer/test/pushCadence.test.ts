import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PUSH_CONFIG,
  PushCadenceInstrument,
  detectNewParagraph,
  extractParagraphs,
  type PushCadenceDeps,
} from '../src/instruments/pushCadence';
import type { CoachResult, ProcessEventInput } from '../src/service/types';

const PARA_1 =
  'Detection is a losing race because the generators improve faster than the detectors can.';
const PARA_2 =
  'A better approach changes the writing environment itself so honest work is the easy path.';

describe('extractParagraphs / detectNewParagraph', () => {
  it('splits on blank lines and trims', () => {
    expect(extractParagraphs(`${PARA_1}\n\n  ${PARA_2}  \n\n\n`)).toEqual([PARA_1, PARA_2]);
  });

  it('detects a newly completed paragraph with its offset', () => {
    const oldText = PARA_1;
    const newText = `${PARA_1}\n\n${PARA_2}`;
    expect(detectNewParagraph(oldText, newText, 50)).toEqual({
      text: PARA_2,
      offset: newText.indexOf(PARA_2),
    });
  });

  it('returns null when no paragraph was added or it is too short', () => {
    expect(detectNewParagraph(PARA_1, `${PARA_1} extended.`, 50)).toBeNull();
    expect(detectNewParagraph(PARA_1, `${PARA_1}\n\nToo short.`, 50)).toBeNull();
  });
});

describe('PushCadenceInstrument', () => {
  const okResult: CoachResult = {
    ok: true,
    observations: [
      {
        anchor: { start: 0, end: 10 },
        kind: 'implicit_claim',
        reflection: 'An unstated premise carries the paragraph.',
        question: 'What makes the premise safe to assume?',
      },
    ],
    provider: 'fake',
    model: 'fake-1',
  };

  function setup(overrides: Partial<PushCadenceDeps> = {}) {
    const events: ProcessEventInput[] = [];
    const coached: string[] = [];
    let nowMs = 1_000_000;
    const instrument = new PushCadenceInstrument(
      {
        coach: async (text) => {
          coached.push(text);
          return okResult;
        },
        available: () => true,
        emit: (e) => events.push(e),
        now: () => nowMs,
        ...overrides,
      },
      DEFAULT_PUSH_CONFIG,
    );
    return { instrument, events, coached, advance: (ms: number) => (nowMs += ms) };
  }

  it('pushes coaching after a settled new paragraph and journals cadence metadata', async () => {
    const { instrument, events, coached } = setup();
    instrument.feedChange(PARA_1);
    instrument.feedChange(`${PARA_1}\n\n${PARA_2}`);

    const result = await instrument.onIdle();
    expect(result.triggered).toBe(true);
    expect(coached).toEqual([PARA_2]);
    expect(events[0]).toMatchObject({
      type: 'push_coaching',
      size: PARA_2.length,
      meta: { refused: false, observations: 1 },
    });
  });

  it('does not push without a coaching config (unobtrusive default)', async () => {
    const { instrument, coached } = setup({ available: () => false });
    instrument.feedChange(PARA_1);
    instrument.feedChange(`${PARA_1}\n\n${PARA_2}`);
    expect((await instrument.onIdle()).triggered).toBe(false);
    expect(coached).toHaveLength(0);
  });

  it('treats the initial document load as not-new', async () => {
    const { instrument } = setup();
    instrument.feedChange(`${PARA_1}\n\n${PARA_2}`); // first feed = existing draft
    expect((await instrument.onIdle()).triggered).toBe(false);
  });

  it('rate-limits successive pushes', async () => {
    const { instrument, advance } = setup();
    instrument.feedChange(PARA_1);
    instrument.feedChange(`${PARA_1}\n\n${PARA_2}`);
    expect((await instrument.onIdle()).triggered).toBe(true);

    advance(1000);
    const third = `${PARA_1}\n\n${PARA_2}\n\n${PARA_1} And then some more of it here.`;
    instrument.feedChange(third);
    expect(await instrument.onIdle()).toMatchObject({ triggered: false, reason: 'Rate limited.' });

    advance(31_000);
    instrument.feedChange(`${third}\n\n${PARA_2} Once again with new words to spare.`);
    expect((await instrument.onIdle()).triggered).toBe(true);
  });

  it('does not re-trigger on the same paragraph after an idle pass', async () => {
    const { instrument, advance } = setup();
    instrument.feedChange(PARA_1);
    instrument.feedChange(`${PARA_1}\n\n${PARA_2}`);
    expect((await instrument.onIdle()).triggered).toBe(true);
    advance(60_000);
    expect((await instrument.onIdle()).triggered).toBe(false); // boundary consumed
  });

  it('honors session silence and dismissal', async () => {
    const { instrument } = setup();
    instrument.feedChange(PARA_1);
    instrument.feedChange(`${PARA_1}\n\n${PARA_2}`);

    instrument.silenceSession();
    expect((await instrument.onIdle()).triggered).toBe(false);
    instrument.unsilenceSession();

    instrument.dismiss();
    expect((await instrument.onIdle()).triggered).toBe(false);

    // A new change resets the dismissal.
    instrument.feedChange(`${PARA_1}\n\n${PARA_2} `);
    expect(instrument.isSilenced).toBe(false);
  });

  it('journals refused pushes too', async () => {
    const refused: CoachResult = {
      ok: false,
      refused: true,
      layer: 'deterministic',
      reason: 'overlap',
    };
    const { instrument, events } = setup({ coach: async () => refused });
    instrument.feedChange(PARA_1);
    instrument.feedChange(`${PARA_1}\n\n${PARA_2}`);
    const result = await instrument.onIdle();
    expect(result.triggered).toBe(true);
    expect(events[0].meta).toMatchObject({ refused: true, observations: 0 });
  });
});
