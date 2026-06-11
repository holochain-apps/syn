export interface SynConfig {
  heartbeatInterval: number;
  /** Interval for polling the DHT for session participants. Also refreshes
   *  the presence (lastSeen) of known participants from their session links,
   *  so that leader election keeps working when signals don't get through.
   *  Must be smaller than outOfSessionTimeout, or participants flap offline
   *  between polls whenever signals fail. Note: up to version 0.600.x this
   *  value was internally multiplied by 10; it is now used as-is. */
  newPeersDiscoveryInterval: number;
  outOfSessionTimeout: number;
  inactiveSessionThreshold: number;
  /** How long the participant view must remain unchanged before this agent
   *  may exercise its leadership rank (commit/merge on the session's behalf).
   *  During partitions and rejoins every node's participant list is churning
   *  and ranks computed from it disagree across nodes; waiting for a settled
   *  view prevents commit storms from spuriously-elected leaders. */
  viewSettlingWindow: number;
  /** Width of each leadership rank's takeover window: when local changes
   *  have gone uncommitted for longer than commitStaggerWindow * rank, a
   *  non-leader steps in and commits them itself. */
  commitStaggerWindow: number;
  /** How long an agent may go without sending us any direct signal before it
   *  stops counting toward the leadership order. Session links in the DHT
   *  prove membership but not liveness: an agent that crashed without
   *  leaving keeps its link forever, and without this timeout it would hold
   *  its leadership rank (possibly rank 0) indefinitely. */
  ghostSignalTimeout: number;
  commitStrategy: CommitStrategy;
}

// Or both
export interface CommitStrategy {
  CommitEveryNMs: number | undefined;
  CommitEveryNDeltas: number | undefined;
  /** Write a full-state snapshot commit after this many consecutive delta
   *  commits. Merge commits and first commits are always snapshots. */
  SnapshotEveryNCommits: number;
}

export function defaultConfig(): SynConfig {
  return {
    heartbeatInterval: 2 * 1000,
    newPeersDiscoveryInterval: 20 * 1000,
    outOfSessionTimeout: 60 * 1000,
    inactiveSessionThreshold: 15 * 1000,
    viewSettlingWindow: 4 * 1000,
    commitStaggerWindow: 60 * 1000,
    ghostSignalTimeout: 5 * 60 * 1000,
    commitStrategy: {
      CommitEveryNDeltas: 30,
      CommitEveryNMs: 1000 * 10,
      SnapshotEveryNCommits: 20,
    },
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