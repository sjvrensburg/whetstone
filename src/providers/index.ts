/**
 * `providers/` — The swappable cloud-inference seam (ADR-004). The only module
 * that talks to a cloud endpoint, reading the user's BYO key from SecretStorage
 * and calling the provider directly — no Whetstone backend, no account.
 *
 * Task 09 adds the CoachingProvider interface, the OpenAI-compatible reference
 * implementation (ZAI/GLM), prompts, and the provider registry.
 */

export * from './openaiCompatible';
export * from './prompts';
export * from './registry';
export * from './types';
