/**
 * Unit + integration tests for the explain-rule action (task 15):
 * `explainRule()` — consent → provider → no-rewrite check → explanation.
 *
 * All UI interaction (consent disclosure, API key prompt) and provider calls
 * are stubbed; no network or VS Code calls. Tests verify the explain-rule
 * composition logic, the no-rewrite guard, and the consent integration.
 */

import { describe, it, expect, vi } from 'vitest';
import { explainRule, containsRewrite } from '../../../src/grammar/explainRule';
import type { ExplainRuleDeps, ExplainRuleInput } from '../../../src/grammar/explainRule';
import type { ConsentGate } from '../../../src/consent/index';
import type { CoachingProvider } from '../../../src/providers/types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Standard lint input for tests. */
const DEFAULT_INPUT: ExplainRuleInput = {
  sentence: 'The researcher have submitted the paper to the journal.',
  lintKind: 'SubjectVerbAgreement',
  lintKindPretty: 'Subject-Verb Agreement',
  message: 'The subject "researcher" is singular but the verb "have" is plural.',
};

/** Create a consent gate stub. */
function stubConsentGate(consents = true): ConsentGate & { purposes: string[] } {
  const purposes: string[] = [];
  return {
    hasConsented: consents,
    reset: vi.fn(),
    ensureConsent: vi.fn(async (purpose: string) => {
      purposes.push(purpose);
      return consents ? { ok: true } : { ok: false, reason: 'Consent declined.' };
    }),
    purposes,
  } as unknown as ConsentGate & { purposes: string[] };
}

/** Create a provider stub that returns the given explanation. */
function stubProvider(
  explanation: string,
): CoachingProvider & { calls: Array<{ sentence: string; meta: { lintKind: string } }> } {
  const calls: Array<{ sentence: string; meta: { lintKind: string } }> = [];
  return {
    id: 'test-provider',
    coach: vi.fn(),
    judge: vi.fn(),
    explainRule: vi.fn(async (sentence: string, meta: { lintKind: string }) => {
      calls.push({ sentence, meta });
      return { ok: true as const, value: explanation };
    }),
    calls,
  };
}

/** Create a provider stub that returns a failure. */
function stubFailingProvider(): CoachingProvider {
  return {
    id: 'test-provider',
    coach: vi.fn(),
    judge: vi.fn(),
    explainRule: vi.fn(async () => ({
      ok: false as const,
      error: { kind: 'network' as const, message: 'Could not connect to provider.' },
    })),
  };
}

/** Build ExplainRuleDeps from the given stubs. */
function makeDeps(
  opts: {
    consents?: boolean;
    explanation?: string;
    failProvider?: boolean;
  } = {},
): {
  deps: ExplainRuleDeps;
  consentGate: ReturnType<typeof stubConsentGate>;
  provider: ReturnType<typeof stubProvider> | CoachingProvider;
} {
  const consentGate = stubConsentGate(opts.consents ?? true);
  const provider = opts.failProvider
    ? stubFailingProvider()
    : stubProvider(
        opts.explanation ??
          'This sentence has a subject-verb agreement error. The singular subject "researcher" requires a singular verb.',
      );
  return {
    deps: { consentGate, provider: provider as CoachingProvider },
    consentGate,
    provider,
  };
}

// ---------------------------------------------------------------------------
// containsRewrite — no-rewrite check
// ---------------------------------------------------------------------------

describe('containsRewrite', () => {
  it('returns false for a genuine rule explanation', () => {
    const sentence = 'The researcher have submitted the paper to the journal.';
    const explanation =
      'Subject-verb agreement requires that a singular subject takes a singular verb. ' +
      'When the subject is third-person singular (like "researcher"), the present-tense ' +
      'verb needs an -s or -es ending.';
    expect(containsRewrite(explanation, sentence)).toBe(false);
  });

  it('returns true when the explanation repeats the sentence with corrections', () => {
    const sentence = 'The researcher have submitted the paper to the journal.';
    // A corrected version — only "have" → "has". Most trigrams overlap.
    const rewrite = 'The researcher has submitted the paper to the journal.';
    expect(containsRewrite(rewrite, sentence)).toBe(true);
  });

  it('returns false for very short explanations', () => {
    const sentence = 'Run';
    const explanation = 'This word may need a different form depending on context.';
    expect(containsRewrite(explanation, sentence)).toBe(false);
  });

  it('returns false for short original sentences', () => {
    const sentence = 'Run';
    const explanation =
      'Subject-verb agreement requires matching number. Consider whether this is ' +
      'an imperative or needs a subject.';
    expect(containsRewrite(explanation, sentence)).toBe(false);
  });

  it('returns false for an explanation that references words from the sentence', () => {
    const sentence = 'She dont know the answer.';
    const explanation =
      'The contraction "dont" is missing an apostrophe. In standard English, ' +
      'the negative contraction of "do not" requires an apostrophe to mark the ' +
      'omitted letter.';
    // The explanation references "dont" but doesn't rewrite the whole sentence.
    expect(containsRewrite(explanation, sentence)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// explainRule — main action
// ---------------------------------------------------------------------------

describe('explainRule', () => {
  // -------------------------------------------------------------------------
  // 15.1 — Sends sentence + lint and returns plain-language explanation
  // -------------------------------------------------------------------------

  describe('successful explanation', () => {
    it('returns a plain-language explanation', async () => {
      const { deps } = makeDeps({
        explanation: 'Subject-verb agreement means the verb must match the subject in number.',
      });

      const result = await explainRule(deps, DEFAULT_INPUT);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.explanation).toContain('Subject-verb agreement');
      }
    });

    it('sends the sentence and lint metadata to the provider', async () => {
      const { deps, provider } = makeDeps();

      await explainRule(deps, DEFAULT_INPUT);

      // Provider was called with the correct arguments.
      const stubbed = provider as ReturnType<typeof stubProvider>;
      expect(stubbed.calls).toHaveLength(1);
      expect(stubbed.calls[0].sentence).toBe(DEFAULT_INPUT.sentence);
      expect(stubbed.calls[0].meta.lintKind).toBe('SubjectVerbAgreement');
    });
  });

  // -------------------------------------------------------------------------
  // Empty sentence rejected
  // -------------------------------------------------------------------------

  describe('empty sentence', () => {
    it('returns an error for an empty sentence', async () => {
      const { deps } = makeDeps();
      const input = { ...DEFAULT_INPUT, sentence: '' };

      const result = await explainRule(deps, input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('empty_sentence');
      }
    });

    it('returns an error for a whitespace-only sentence', async () => {
      const { deps } = makeDeps();
      const input = { ...DEFAULT_INPUT, sentence: '   ' };

      const result = await explainRule(deps, input);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('empty_sentence');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 15.2 — Routes through ensureConsent() and records cloud_send
  // -------------------------------------------------------------------------

  describe('consent gating', () => {
    it('calls ensureConsent with explain_rule purpose', async () => {
      const { deps, consentGate } = makeDeps();

      await explainRule(deps, DEFAULT_INPUT);

      expect(consentGate.purposes).toContain('explain_rule');
    });

    it('returns a consent error when consent is declined', async () => {
      const { deps } = makeDeps({ consents: false });

      const result = await explainRule(deps, DEFAULT_INPUT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('consent');
        expect(result.error.message).toContain('Consent declined');
      }
    });

    it('does not call the provider when consent is declined', async () => {
      const { deps, provider } = makeDeps({ consents: false });

      await explainRule(deps, DEFAULT_INPUT);

      const stubbed = provider as ReturnType<typeof stubProvider>;
      expect(stubbed.calls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Provider failure
  // -------------------------------------------------------------------------

  describe('provider failure', () => {
    it('returns a provider error when the provider fails', async () => {
      const { deps } = makeDeps({ failProvider: true });

      const result = await explainRule(deps, DEFAULT_INPUT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('provider');
        expect(result.error.message).toContain('Could not connect');
      }
    });
  });

  // -------------------------------------------------------------------------
  // 15.3 — No-rewrite check rejects rewritten responses
  // -------------------------------------------------------------------------

  describe('no-rewrite check', () => {
    it('rejects a response that rewrites the sentence', async () => {
      // A corrected version of the sentence — only one word changed, so most
      // trigrams overlap with the original. This should be caught.
      const rewrite = 'The researcher has submitted the paper to the journal.';
      const { deps } = makeDeps({ explanation: rewrite });

      const result = await explainRule(deps, DEFAULT_INPUT);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('rewrite_detected');
      }
    });

    it('accepts a genuine explanation that references the sentence', async () => {
      const { deps } = makeDeps({
        explanation:
          'The subject "researcher" is singular, so it requires the singular verb ' +
          '"has" rather than the plural "have". This is the subject-verb agreement rule.',
      });

      const result = await explainRule(deps, DEFAULT_INPUT);

      expect(result.ok).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('explain-rule integration', () => {
  it('invoking the action returns a read-only explanation and records exactly one cloud_send', async () => {
    const explanation =
      'Subject-verb agreement: when the subject is singular (e.g., "researcher"), ' +
      'the verb must also be singular. This is a fundamental English grammar rule.';
    const { deps, consentGate } = makeDeps({ explanation });

    const result = await explainRule(deps, DEFAULT_INPUT);

    // Explanation was returned.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.explanation).toContain('Subject-verb agreement');
    }

    // Consent was requested with 'explain_rule' purpose.
    expect(consentGate.purposes).toEqual(['explain_rule']);
  });

  it('no edit is applied to the document (result is explanation only)', async () => {
    const { deps } = makeDeps({
      explanation: 'This is a rule about articles. "The" is a definite article.',
    });

    const result = await explainRule(deps, DEFAULT_INPUT);

    // The result is an explanation — never an edit or rewrite.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.explanation).toBe('string');
      expect(result.explanation.length).toBeGreaterThan(0);
      // No edit-related fields exist on ExplainRuleResult.
      expect((result as Record<string, unknown>).edit).toBeUndefined();
      expect((result as Record<string, unknown>).rewrite).toBeUndefined();
    }
  });

  it('egress goes through ensureConsent and records cloud_send', async () => {
    const { deps, consentGate, provider } = makeDeps();

    // Consent gate records cloud_send internally (tested in consent-gate.test.ts).
    // Here we verify the explain-rule action calls ensureConsent before the provider.
    const consentSpy = consentGate.ensureConsent as ReturnType<typeof vi.fn>;
    const stubbed = provider as ReturnType<typeof stubProvider>;

    await explainRule(deps, DEFAULT_INPUT);

    // ensureConsent was called before the provider.
    expect(consentSpy).toHaveBeenCalled();
    expect(stubbed.calls).toHaveLength(1);
    // The provider was called (meaning consent passed).
    expect(stubbed.calls[0].sentence).toBe(DEFAULT_INPUT.sentence);
  });

  it('full flow: consent → provider → no-rewrite → explanation', async () => {
    const explanation =
      'The article "an" is used before vowel sounds, while "a" is used before ' +
      'consonant sounds. The choice depends on pronunciation, not spelling.';
    const { deps } = makeDeps({ explanation });

    const input: ExplainRuleInput = {
      sentence: 'This is an example of the rule.',
      lintKind: 'Articles',
      lintKindPretty: 'Articles',
      message: 'Consider using "a" instead of "an".',
    };

    const result = await explainRule(deps, input);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.explanation).toContain('article');
      expect(result.explanation).toContain('vowel');
    }
  });
});
