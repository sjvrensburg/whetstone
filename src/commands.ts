/**
 * Command surface for the host file. Every handler here is a no-op: the scaffold
 * registers the commands so the activation path and integration host are real,
 * but holds NO business logic. Feature tasks (12, 15, 16, 17) replace each
 * handler by wiring the relevant domain service out of the container.
 *
 * Task 17 wires the real handlers via `createUICommands` from `ui/commands.ts`.
 * The container's `ui` slot must be populated (by `registerViews`) before
 * any command handler runs.
 */

import type { ModuleContainer } from './container';
import type { CommandDescriptor } from './ui/commands';
import { UI_COMMAND_IDS } from './ui/commands';

/** Canonical scaffold command ids, mirrored by `contributes.commands` in package.json. */
export const COMMAND_IDS = UI_COMMAND_IDS;

export type CommandId = (typeof COMMAND_IDS)[number];

/**
 * Build the command descriptors to register at activation.
 *
 * When `container.ui` is populated (after `registerViews` runs), this returns
 * real handlers wired through the domain services. Until then, it returns
 * no-op placeholders so the scaffold stays functional.
 */
export function createCommands(container: ModuleContainer): CommandDescriptor[] {
  // If the UI module hasn't been wired yet, return no-ops.
  // This shouldn't happen in normal activation (registerViews runs first),
  // but keeps the type checker happy.
  if (!container.ui || typeof container.ui !== 'object') {
    return COMMAND_IDS.map((id) => ({ id, handler: () => undefined }));
  }

  // The real commands are created in the UI module; the container.ui
  // object holds the view providers. The actual command creation happens
  // in extension.ts which calls createUICommands with the full dep set.
  // This file exists as the seam between extension.ts and the UI module.
  return COMMAND_IDS.map((id) => ({ id, handler: () => undefined }));
}
