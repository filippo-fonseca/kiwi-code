import type { BgsdPush } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import {
  type BgsdFeedRegistry,
  type BgsdWorkspaceSubscription,
  createBgsdRealFeed,
} from "./realFeed";

/**
 * A tiny fake of the atom registry seam realFeed drives. It records every
 * subscription so a test can (a) push values through a specific atom's handler
 * and (b) assert exactly when subscriptions are opened and torn down.
 */
interface FakeSubscription {
  readonly atom: Atom.Atom<unknown>;
  readonly handler: (value: unknown) => void;
  released: boolean;
}

function makeFakeRegistry(initial: Map<Atom.Atom<unknown>, unknown>) {
  const values = new Map(initial);
  const subscriptions: FakeSubscription[] = [];

  const registry: BgsdFeedRegistry = {
    get: <A>(atom: Atom.Atom<A>): A => values.get(atom as Atom.Atom<unknown>) as A,
    subscribe: <A>(atom: Atom.Atom<A>, handler: (value: A) => void) => {
      const record: FakeSubscription = {
        atom: atom as Atom.Atom<unknown>,
        handler: handler as (value: unknown) => void,
        released: false,
      };
      subscriptions.push(record);
      return () => {
        record.released = true;
      };
    },
  };

  return {
    registry,
    subscriptions,
    setValue: (atom: Atom.Atom<unknown>, value: unknown) => values.set(atom, value),
    /** Emit into whichever subscription targets `atom` (the last live one). */
    emit: (atom: Atom.Atom<unknown>, value: unknown) => {
      for (const sub of subscriptions) {
        if (sub.atom === atom && !sub.released) sub.handler(value);
      }
    },
    handlerFor: (atom: Atom.Atom<unknown>) =>
      subscriptions.find((sub) => sub.atom === atom && !sub.released)?.handler,
  };
}

const ENV_A = EnvironmentId.make("env-a");
const ENV_B = EnvironmentId.make("env-b");

// Distinct atom identities so the fake registry can route by reference.
const envAtom = { id: "env" } as unknown as Atom.Atom<EnvironmentId | null>;
const workspaceAtoms = new Map<
  EnvironmentId,
  Atom.Atom<AsyncResult.AsyncResult<BgsdPush, unknown>>
>();
const subscription: BgsdWorkspaceSubscription = ({ environmentId }) => {
  let atom = workspaceAtoms.get(environmentId);
  if (!atom) {
    atom = { id: `ws:${environmentId}` } as unknown as Atom.Atom<
      AsyncResult.AsyncResult<BgsdPush, unknown>
    >;
    workspaceAtoms.set(environmentId, atom);
  }
  return atom;
};

const snapshotPush: BgsdPush = {
  kind: "bgsd_snapshot",
  snapshot: { workspaceRoot: "/ws", available: true },
};
const unavailablePush: BgsdPush = { kind: "bgsd_unavailable", workspaceRoot: "/ws" };

function success(push: BgsdPush): AsyncResult.AsyncResult<BgsdPush, unknown> {
  return AsyncResult.success(push);
}

describe("realFeed — push fan-out", () => {
  it("does not subscribe to a workspace until subscribe() is called (lazy)", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, ENV_A]]);
    const fake = makeFakeRegistry(env);
    createBgsdRealFeed({ registry: fake.registry, environmentIdAtom: envAtom, subscription });
    expect(fake.subscriptions).toHaveLength(0);
  });

  it("delivers each successful push to the handler", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, ENV_A]]);
    const fake = makeFakeRegistry(env);
    const feed = createBgsdRealFeed({
      registry: fake.registry,
      environmentIdAtom: envAtom,
      subscription,
    });

    const received: BgsdPush[] = [];
    feed.subscribe((push) => received.push(push));

    const wsAtom = subscription({ environmentId: ENV_A, input: {} }) as Atom.Atom<unknown>;
    fake.emit(wsAtom, success(snapshotPush));
    fake.emit(wsAtom, success(unavailablePush));

    expect(received).toEqual([snapshotPush, unavailablePush]);
  });

  it("swallows failure/waiting results and only forwards successes", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, ENV_A]]);
    const fake = makeFakeRegistry(env);
    const feed = createBgsdRealFeed({
      registry: fake.registry,
      environmentIdAtom: envAtom,
      subscription,
    });

    const received: BgsdPush[] = [];
    feed.subscribe((push) => received.push(push));

    const wsAtom = subscription({ environmentId: ENV_A, input: {} }) as Atom.Atom<unknown>;
    fake.emit(wsAtom, AsyncResult.initial(true));
    fake.emit(wsAtom, success(snapshotPush));

    expect(received).toEqual([snapshotPush]);
  });

  it("fans out one workspace stream to multiple independent subscribers", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, ENV_A]]);
    const fake = makeFakeRegistry(env);
    const feed = createBgsdRealFeed({
      registry: fake.registry,
      environmentIdAtom: envAtom,
      subscription,
    });

    const first: BgsdPush[] = [];
    const second: BgsdPush[] = [];
    feed.subscribe((push) => first.push(push));
    feed.subscribe((push) => second.push(push));

    const wsAtom = subscription({ environmentId: ENV_A, input: {} }) as Atom.Atom<unknown>;
    fake.emit(wsAtom, success(snapshotPush));

    expect(first).toEqual([snapshotPush]);
    expect(second).toEqual([snapshotPush]);
  });
});

describe("realFeed — unsubscribe semantics", () => {
  it("releases both the environment and workspace subscriptions on unsubscribe", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, ENV_A]]);
    const fake = makeFakeRegistry(env);
    const feed = createBgsdRealFeed({
      registry: fake.registry,
      environmentIdAtom: envAtom,
      subscription,
    });

    const disconnect = feed.subscribe(() => {});
    // One env subscription + one workspace subscription are open.
    expect(fake.subscriptions.filter((s) => !s.released)).toHaveLength(2);

    disconnect();
    expect(fake.subscriptions.every((s) => s.released)).toBe(true);
  });

  it("stops delivering pushes after unsubscribe", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, ENV_A]]);
    const fake = makeFakeRegistry(env);
    const feed = createBgsdRealFeed({
      registry: fake.registry,
      environmentIdAtom: envAtom,
      subscription,
    });

    const received: BgsdPush[] = [];
    const disconnect = feed.subscribe((push) => received.push(push));
    const handler = fake.handlerFor(
      subscription({ environmentId: ENV_A, input: {} }) as Atom.Atom<unknown>,
    );
    disconnect();

    // Even a late emit through a captured handler must not reach the consumer.
    handler?.(success(snapshotPush));
    expect(received).toEqual([]);
  });
});

describe("realFeed — environment binding", () => {
  it("waits for the environment to resolve, then binds the workspace", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, null]]);
    const fake = makeFakeRegistry(env);
    const feed = createBgsdRealFeed({
      registry: fake.registry,
      environmentIdAtom: envAtom,
      subscription,
    });

    const received: BgsdPush[] = [];
    feed.subscribe((push) => received.push(push));

    // Only the env watcher is open while the environment is null.
    expect(
      fake.subscriptions.filter((s) => s.atom === (envAtom as Atom.Atom<unknown>)),
    ).toHaveLength(1);
    const wsAtomBefore = workspaceAtoms.get(ENV_A);
    expect(
      wsAtomBefore ? fake.handlerFor(wsAtomBefore as Atom.Atom<unknown>) : undefined,
    ).toBeUndefined();

    // Environment resolves: the env watcher fires and binds the workspace.
    fake.emit(envAtom as Atom.Atom<unknown>, ENV_A);
    const wsAtom = subscription({ environmentId: ENV_A, input: {} }) as Atom.Atom<unknown>;
    fake.emit(wsAtom, success(snapshotPush));
    expect(received).toEqual([snapshotPush]);
  });

  it("rebinds to the new workspace and drops the old one when the environment changes", () => {
    const env = new Map<Atom.Atom<unknown>, unknown>([[envAtom as Atom.Atom<unknown>, ENV_A]]);
    const fake = makeFakeRegistry(env);
    const feed = createBgsdRealFeed({
      registry: fake.registry,
      environmentIdAtom: envAtom,
      subscription,
    });

    const received: BgsdPush[] = [];
    feed.subscribe((push) => received.push(push));

    const wsAtomA = subscription({ environmentId: ENV_A, input: {} }) as Atom.Atom<unknown>;
    // Environment switches to B: the A workspace subscription must be released.
    fake.emit(envAtom as Atom.Atom<unknown>, ENV_B);
    expect(fake.subscriptions.find((s) => s.atom === wsAtomA)?.released).toBe(true);

    const wsAtomB = subscription({ environmentId: ENV_B, input: {} }) as Atom.Atom<unknown>;
    fake.emit(wsAtomB, success(snapshotPush));
    // A push on the stale A stream must not arrive (its handler is released).
    fake.emit(wsAtomA, success(unavailablePush));
    expect(received).toEqual([snapshotPush]);
  });
});
