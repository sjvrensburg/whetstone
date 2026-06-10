/**
 * Dependency-wiring seam (Component Overview boundary).
 *
 * `createContainer` returns the registry of domain-service slots that
 * `extension.ts` wires at activation time. The scaffold leaves every slot empty;
 * each owning task populates its own slot (e.g. task 07 fills `ledger`, task 09
 * fills `providers`). No business logic lives here, and the module deliberately
 * avoids a runtime dependency on `vscode` so it stays headlessly unit-testable.
 */

/**
 * The minimal host surface the container needs. The real
 * `vscode.ExtensionContext` satisfies this structurally, so the seam can accept
 * the live context at activation while remaining testable with a plain stub.
 */
export interface HostContext {
  readonly subscriptions: { push(...items: { dispose(): unknown }[]): void };
}

/** The domain-service module slots, in Component Overview order. */
export const MODULE_SLOTS = [
  'shared',
  'providers',
  'coaching',
  'guard',
  'grammar',
  'ledger',
  'brief',
  'consent',
  'ui',
  'telemetry',
] as const;

export type ModuleName = (typeof MODULE_SLOTS)[number];

/** A populated module instance; `undefined` until its owning task wires it. */
export type ModuleSlot = unknown;

/** The container is the map of module name to its (eventual) service instance. */
export type ModuleContainer = Record<ModuleName, ModuleSlot>;

/**
 * Build the dependency container. Accepts the host context so later tasks can
 * wire context-dependent services (SecretStorage, global storage) through the
 * same seam; the scaffold ignores it and leaves every slot empty.
 */
export function createContainer(_context?: HostContext): ModuleContainer {
  const container = {} as ModuleContainer;
  for (const name of MODULE_SLOTS) {
    container[name] = undefined;
  }
  return container;
}
