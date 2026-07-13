/**
 * kiwi-ui: the production {@link BgsdFeed}, backed by the `subscribeBgsdWorkspace`
 * streaming RPC.
 *
 * It mirrors every other durable per-environment push channel in the app (server
 * lifecycle, terminal events, vcs status): a subscription atom built with
 * `createEnvironmentRpcSubscriptionAtomFamily` over `connectionAtomRuntime`, whose
 * underlying `subscribe()` helper switch-maps on session changes — so a dropped
 * WebSocket resubscribes automatically the moment the environment reconnects,
 * with no work here.
 *
 * Consumption is imperative (this is not React): `registry.subscribe(atom, …)`
 * mounts the atom, drives the RPC for as long as we stay subscribed, and its
 * returned callback tears the whole thing down. Delivery is lazy — nothing runs
 * until `subscribe()` is called.
 *
 * The workspace is scoped to the *primary* environment (the same-origin local
 * backend), so we watch `primaryEnvironmentIdAtom` and (re)bind the workspace
 * subscription whenever it resolves or changes. `workspaceRoot` is omitted from
 * the payload: the server then observes its own configured root (ServerConfig.cwd).
 */
import type { BgsdPush } from "@t3tools/contracts";
import { WS_METHODS } from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { createEnvironmentRpcSubscriptionAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import type { BgsdFeed } from "./feed";

/** The workspace push subscription, keyed by `{ environmentId, input }`. */
const bgsdWorkspaceSubscription = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "kiwi:bgsd-workspace",
    tag: WS_METHODS.subscribeBgsdWorkspace,
  },
);

/** The subset of the atom registry this feed drives, so tests can supply a fake. */
export interface BgsdFeedRegistry {
  readonly get: <A>(atom: Atom.Atom<A>) => A;
  readonly subscribe: <A>(
    atom: Atom.Atom<A>,
    handler: (value: A) => void,
    options?: { readonly immediate?: boolean },
  ) => () => void;
}

/** An atom family producing the workspace push stream for a given environment. */
export type BgsdWorkspaceSubscription = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: { readonly workspaceRoot?: string | null };
}) => Atom.Atom<AsyncResult.AsyncResult<BgsdPush, unknown>>;

export interface BgsdRealFeedOptions {
  readonly registry?: BgsdFeedRegistry;
  /** Resolves the environment the workspace lives on, and notifies on change. */
  readonly environmentIdAtom?: Atom.Atom<EnvironmentId | null>;
  readonly subscription?: BgsdWorkspaceSubscription;
}

/**
 * Build the production feed, or an injectable one for tests. Defaults wire the
 * real app registry, primary-environment atom, and workspace subscription.
 */
export function createBgsdRealFeed(options: BgsdRealFeedOptions = {}): BgsdFeed {
  const registry: BgsdFeedRegistry = options.registry ?? appAtomRegistry;
  const environmentIdAtom = options.environmentIdAtom ?? primaryEnvironmentIdAtom;
  const subscription =
    options.subscription ?? (bgsdWorkspaceSubscription as BgsdWorkspaceSubscription);

  return {
    subscribe(handler: (push: BgsdPush) => void): () => void {
      let disposed = false;
      // The active workspace subscription's teardown, when an environment is bound.
      let unbindWorkspace: (() => void) | undefined;

      const bind = (environmentId: EnvironmentId | null): void => {
        // Tear down the previous binding before (re)binding to a new environment.
        unbindWorkspace?.();
        unbindWorkspace = undefined;
        if (disposed || environmentId === null) return;
        const atom = subscription({ environmentId, input: {} });
        unbindWorkspace = registry.subscribe(atom, (result) => {
          if (disposed) return;
          if (AsyncResult.isSuccess(result)) handler(result.value);
          // Failures/waiting states are swallowed here: the store shows "offline"
          // only via an explicit bgsd_unavailable push, and the subscription
          // resubscribes on its own once the environment reconnects.
        });
      };

      // Bind now (if the environment is already known) and on every change.
      const unbindEnvironment = registry.subscribe(environmentIdAtom, bind);
      bind(registry.get(environmentIdAtom));

      return () => {
        disposed = true;
        unbindEnvironment();
        unbindWorkspace?.();
        unbindWorkspace = undefined;
      };
    },
  };
}

/** The default production feed, wired to the real app registry and connection. */
export const bgsdRealFeed: BgsdFeed = createBgsdRealFeed();
