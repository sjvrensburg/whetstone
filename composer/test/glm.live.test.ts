import 'fake-indexeddb/auto';
/**
 * Live end-to-end coaching test against Z.ai / GLM (slice 5).
 *
 * Network test — runs ONLY when explicitly opted in:
 *   LIVE=1 Z_AI_API_KEY=... npx vitest run test/glm.live.test.ts
 *
 * Exercises the real pipeline: prompt build → GLM structured completion →
 * schema validation → deterministic guard → journal.
 */
import { describe, expect, it } from 'vitest';
import { LocalService } from '../src/service/local';
import { OpenAICompatibleCoachProvider } from '../src/service/provider';

const apiKey = process.env.Z_AI_API_KEY;
const live = process.env.LIVE === '1' && !!apiKey;

const SELECTION =
  'Universities respond to AI writing tools mostly with detection software, but detection is ' +
  'a losing race. The tools improve faster than the detectors, and false accusations hurt ' +
  'honest students more than cheaters. A better approach changes the writing environment ' +
  'itself, so that doing the work is easier than faking it.';

describe.skipIf(!live)('GLM live coaching (network)', () => {
  it('returns guarded structural observations for a real passage', async () => {
    const svc = new LocalService(`live-${Date.now()}`);
    await svc.startSession('live-doc');
    svc.setProvider(new OpenAICompatibleCoachProvider({ apiKey: apiKey! }));

    const result = await svc.coach({
      selectionText: SELECTION,
      claim: 'Friction beats detection for keeping student writing honest.',
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.observations.length).toBeGreaterThan(0);
      expect(result.provider).toBe('zai');
      for (const obs of result.observations) {
        expect(obs.question.trim().endsWith('?')).toBe(true);
      }
    }

    const record = await svc.getRecord('live-doc');
    const consult = record.find((e) => e.type === 'coach_consult');
    expect(consult?.meta).toMatchObject({ provider: 'zai', model: 'glm-5.1' });
    // Metadata only — the journal must not contain the passage.
    expect(JSON.stringify(record)).not.toContain('detection software');
  }, 120_000);

  it('answers a chat turn without writing prose', async () => {
    const svc = new LocalService(`live-chat-${Date.now()}`);
    await svc.startSession('live-chat-doc');
    svc.setProvider(new OpenAICompatibleCoachProvider({ apiKey: apiKey! }));

    const result = await svc.coachChat({
      message: 'Is my argument against detection software convincing, or am I missing something?',
      history: [],
      contextText: SELECTION,
      claim: 'Friction beats detection for keeping student writing honest.',
    });

    // eslint-disable-next-line no-console
    console.log(JSON.stringify(result, null, 2));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.reply.length).toBeGreaterThan(20);
    }
  }, 120_000);
});
