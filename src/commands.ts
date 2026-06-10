import type { ModuleContainer } from './container';

/**
 * Command surface for the host file. Every handler here is a no-op: the scaffold
 * registers the commands so the activation path and integration host are real,
 * but holds NO business logic. Feature tasks (12, 15, 16, 17) replace each
 * handler by wiring the relevant domain service out of the container.
 */
export interface CommandDescriptor {
  readonly id: string;
  readonly handler: (...args: unknown[]) => unknown;
}

/** Canonical scaffold command ids, mirrored by `contributes.commands` in package.json. */
export const COMMAND_IDS = [
  'whetstone.coachSelection',
  'whetstone.openTransparencyReport',
  'whetstone.toggleLedger',
] as const;

export type CommandId = (typeof COMMAND_IDS)[number];

/**
 * Build the command descriptors to register at activation. The container is the
 * wiring seam later tasks read from; for now every handler resolves to a no-op.
 */
export function createCommands(_container: ModuleContainer): CommandDescriptor[] {
  return COMMAND_IDS.map((id) => ({
    id,
    handler: () => undefined,
  }));
}
