export interface SynConfig {
  hearbeatInterval: number;
  /** Interval for polling the DHT for new session participants.
   *  Note: internally multiplied by 10 to determine the actual polling interval. */
  newPeersDiscoveryInterval: number;
  outOfSessionTimeout: number;
  /** Whether to send periodic heartbeat messages for presence tracking.
   *  Set to false when presence is managed externally (e.g. by Moss).
   *  Data sync is unaffected. Default: true. */
  enablePresenceHeartbeat: boolean;
  commitStrategy: CommitStrategy;
}

// Or both
export interface CommitStrategy {
  CommitEveryNMs: number | undefined;
  CommitEveryNDeltas: number | undefined;
}

export function defaultConfig(): SynConfig {
  return {
    hearbeatInterval: 2 * 1000,
    newPeersDiscoveryInterval: 20 * 1000,
    outOfSessionTimeout: 60 * 1000,
    enablePresenceHeartbeat: true,
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