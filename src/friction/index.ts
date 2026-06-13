/**
 * Friction-dial module (ADR-008, task 20).
 *
 * Public surface:
 *   - `Dial` — resolution API (`frictionLevel()`, `instrumentState(name)`)
 *   - `Presets` — preset definitions, instrument types, ordinal helpers
 *   - `FrictionStatusBar` + `showLevelQuickPick` — control surface
 */

export { Dial, resolveEffectiveConfig, DEFAULT_DIAL_CONFIG } from './dial';
export type { DialConfig, InstrumentOverrides, DialObserver } from './dial';

export {
  PRESETS,
  INSTRUMENT_NAMES,
  FRICTION_LEVELS,
  FRICTION_LEVEL_LABELS,
  COACHING_CADENCE_STATES,
  PASTE_HANDLING_STATES,
  CLAIM_FIRST_STATES,
  TEACH_BACK_STATES,
  MIRROR_STATES,
  isValidFrictionLevel,
  stateOrdinal,
  stateAtOrdinal,
} from './presets';
export type {
  FrictionLevel,
  InstrumentName,
  InstrumentState,
  InstrumentStateMap,
  CoachingCadenceState,
  PasteHandlingState,
  ClaimFirstState,
  TeachBackState,
  MirrorState,
} from './presets';

export { FrictionStatusBar, showLevelQuickPick, createFrictionControlCommands } from './control';
export type { FrictionControlDeps } from './control';

export { ClaimFirstGate, CLAIM_PROMPT, CLAIM_PLACEHOLDER, CLAIM_TITLE } from './claimFirst';
export type { ClaimPrompter, ClaimGateResult, ClaimFirstGateDeps } from './claimFirst';

export {
  TeachBackCheckpoint,
  isDisconnect,
  MIN_SUMMARY_LENGTH,
  SUMMARY_TITLE,
  SUMMARY_PROMPT,
  SUMMARY_PLACEHOLDER,
  DISCONNECT_NUDGE,
} from './teachBack';
export type { SummaryPrompter, TeachBackOutcome, TeachBackResult, TeachBackDeps } from './teachBack';

export {
  PushCadence,
  extractParagraphs,
  detectNewParagraph,
  DEFAULT_PUSH_CONFIG,
} from './pushCadence';
export type {
  PushCadenceDeps,
  PushCadenceConfig,
  PushCadenceResult,
} from './pushCadence';

export {
  ProcessMirror,
  MirrorViewDataProvider,
  MirrorItem,
  computeComposition,
  LABELS,
  assertNoProofOfPersonhoodLanguage,
} from './mirror';
export type {
  ProcessMirrorDeps,
  CompositionSnapshot,
  MirrorSnapshot,
} from './mirror';
