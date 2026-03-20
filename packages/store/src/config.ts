export interface SynConfig {
  heartbeatInterval: number;
  /** Interval for polling the DHT for new session participants.
   *  Note: internally multiplied by 10 to determine the actual polling interval. */
  newPeersDiscoveryInterval: number;
  outOfSessionTimeout: number;
  inactiveSessionThreshold: number;
  commitStrategy: CommitStrategy;
}

// Or both
export interface CommitStrategy {
  CommitEveryNMs: number | undefined;
  CommitEveryNDeltas: number | undefined;
}

export function defaultConfig(): SynConfig {
  return {
    heartbeatInterval: 2 * 1000,
    newPeersDiscoveryInterval: 20 * 1000,
    outOfSessionTimeout: 60 * 1000,
    inactiveSessionThreshold: 20 * 1000,
    commitStrategy: { CommitEveryNDeltas: 30, CommitEveryNMs: 1000 * 10 }, // TODO: reduce ms
  };
}

export type RecursivePartial<T> = {
  [P in keyof T]?: T[P] extends (infer U)[]
    ? RecursivePartial<U>[]
    : T[P] extends object
    ? RecursivePartial<T[P]>
    : T[P];
};

export const LINKS_POLL_INTERVAL_MS = 20000