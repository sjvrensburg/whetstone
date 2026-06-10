/**
 * `shared/` — Types, config, SecretStorage access, canonical JSON,
 * hashing/signing. No dependencies on other modules (Component Overview).
 *
 * Task 02 adds the domain types and the move-taxonomy/length-cap constants;
 * task 03 (canonical JSON, SHA-256, Ed25519) and task 04 (config +
 * SecretStorage access) extend this barrel.
 */
export * from './constants';
export * from './crypto';
export * from './json';
export * from './types';
