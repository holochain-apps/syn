import { Commit, SessionMessage } from '@holochain-syn/client';
import {
  EntryRecord,
  HashType,
  retype,
} from '@holochain-open-dev/utils';
import {
  Readable,
  get,
  derived,
  Writable,
  writable,
} from '@holochain-open-dev/stores';
import { decode, encode } from '@msgpack/msgpack';
import * as Automerge from '@automerge/automerge';
import { encodeHashToBase64, AgentPubKey, AgentPubKeyMap } from '@holochain/client';
import isEqual from 'lodash-es/isEqual.js';
import { toPromise } from '@holochain-open-dev/stores';

import { SynConfig } from './config.js';
import { WorkspaceStore } from './workspace-store.js';
import { stateFromCommit } from './syn-store.js';

export type SessionStatus = {
  code: 'ok' | 'error' | 'syncing';
  lastSave?: string;
  error?: string;
}

export interface SliceStore<S, E> {
  myPubKey: AgentPubKey;

  workspace: WorkspaceStore<S, E>;

  state: Readable<S>;
  ephemeral: Readable<E>;

  sessionStatus: Readable<SessionStatus>;

  change(updateFn: (state: S, ephemeral: E) => void): void;
}

export function extractSlice<S1, E1, S2, E2>(
  sliceStore: SliceStore<S1, E1>,
  sliceState: (state: S1) => S2,
  sliceEphemeral: (ephemeralState: E1) => E2
): SliceStore<S2, E2> {
  return {
    myPubKey: sliceStore.myPubKey,
    workspace: sliceStore.workspace as any as WorkspaceStore<S2, E2>,
    state: derived(sliceStore.state, sliceState),
    ephemeral: derived(sliceStore.ephemeral, sliceEphemeral),
    sessionStatus: sliceStore.sessionStatus,
    change: updateFn =>
      sliceStore.change((state1, eph1) => {
        const state2 = sliceState(state1);
        const eph2 = sliceEphemeral(eph1);

        updateFn(state2, eph2);
      }),
  };
}

export interface SessionParticipant {
  /** Last evidence of any kind (direct signal or session link in the DHT)
   *  that the agent is in the session */
  lastSeen: number | undefined;
  /** Last direct signal received from the agent. DHT links prove membership
   *  but not liveness; only signals keep an agent in the leadership order
   *  (see SynConfig.ghostSignalTimeout). */
  lastSignalSeen?: number;
  /** When we first learned about this agent */
  firstSeen?: number;
  lastActive: number | undefined;
  syncStates: { state: Automerge.SyncState; ephemeral: Automerge.SyncState };
}

export class SessionStore<S, E> implements SliceStore<S, E> {
  get workspace() {
    return this.workspaceStore;
  }

  _participants: Writable<AgentPubKeyMap<SessionParticipant>>;
  get participants() {
    return derived(this._participants, i => {
      // Make sure I'm in participants list
      if (!i.has(this.myPubKey)) {
        i.set(this.myPubKey, {
            lastSeen: Date.now(),
            firstSeen: Date.now(),
            lastActive: Date.now(),
            syncStates: {
            state: Automerge.initSyncState(),
            ephemeral: Automerge.initSyncState(),
          },
        });
      }
      // Active is here and active recently
      const isActive = (lastActive: number | undefined) =>
        lastActive && Date.now() - lastActive < this.config.inactiveSessionThreshold;
      // Offline is not seen or active since timeout 
      const isOffline = (lastSeen: number | undefined, lastActive: number | undefined) =>
        !isActive(lastActive) && 
        (!lastSeen || Date.now() - lastSeen > this.config.outOfSessionTimeout);
      // Idle is here and seen recently but not active
      const isIdle = (lastSeen: number | undefined, lastActive: number | undefined) =>
        !isActive(lastActive) && !isOffline(lastSeen, lastActive);

      const entries = Array.from(i.entries()) as [AgentPubKey, SessionParticipant][];

      const active = entries
        .filter(
          ([_, info]) => isActive(info.lastActive))
        .map(([pubkey, _]) => pubkey);

      const idle = entries
        .filter(([_, info]) => isIdle(info.lastSeen, info.lastActive))
        .map(([pubkey, _]) => pubkey);

      // If I'm not in active or idle, add me to idle
      if (!active.find(p => isEqual(p, this.myPubKey)) 
        && !idle.find(p => isEqual(p, this.myPubKey))
      ) {
        idle.push(this.myPubKey);
      }

      const offline = entries
        .filter(([pubkey, info]) => isOffline(info.lastSeen, info.lastActive) && 
            !isEqual(pubkey, this.myPubKey))
        .map(([pubkey, _]) => pubkey);

      return {
        active,
        idle,
        offline,
      };
    });
  }

  _state: Writable<Automerge.Doc<S>>;
  get state(): Readable<S> {
    return derived(this._state, i => Automerge.clone(i) as S);
  }

  _ephemeral: Writable<Automerge.Doc<E>>;
  get ephemeral(): Readable<E> {
    return derived(this._ephemeral, i => JSON.parse(JSON.stringify(i)));
  }

  _currentTip: Writable<EntryRecord<Commit> | undefined>;
  get currentTip() {
    return derived(this._currentTip, i => i);
  }

  _sessionStatus: Writable<SessionStatus> = writable({ code: 'ok' });
  get sessionStatus() {
    return derived(this._sessionStatus, i => i);
  }

  private unsubscribe: () => void = () => { };
  private intervals: any[] = [];
  private deltaCount = 0;

  // Heads of the state recorded in the current tip commit: the basis for
  // the cheap in-sync check
  private _tipHeads: Automerge.Heads | undefined;

  // Leadership rank is only acted on when the participant view has been
  // stable for the settling window and we're outside the collision backoff
  private _viewKey = '';
  private _viewStableSince = Date.now();
  private readonly _joinedAt = Date.now();
  private _backoffUntil = 0;

  // When our local document first diverged from the committed tip;
  // undefined while in sync. Non-leaders take over committing when this age
  // exceeds commitStaggerWindow * rank.
  private _divergedSince: number | undefined;

  // Agents we've seen leave, keyed by base64 pubkey: the discovery poll
  // ignores their lingering session links until the link delete propagates
  private _recentlyLeft: Map<string, number> = new Map();

  get myPubKey() {
    return this.synClient.client.myPubKey;
  }

  get synClient() {
    return this.workspaceStore.documentStore.synStore.client;
  }

  private constructor(
    protected workspaceStore: WorkspaceStore<S, E>,
    protected onLeave: () => void,
    protected config: SynConfig,
    currentState: Automerge.Doc<S>,
    currentTip: EntryRecord<Commit> | undefined,
    sessionStatus: SessionStatus = { code: 'ok', lastSave: currentTip ? new Date(currentTip.action.timestamp).toISOString() : '' },
    initialParticipants: Array<AgentPubKey>
  ) {
    this._sessionStatus.set(sessionStatus);
    if (config.newPeersDiscoveryInterval >= config.outOfSessionTimeout) {
      console.warn(
        'SynConfig: newPeersDiscoveryInterval should be smaller than outOfSessionTimeout; participants may flap offline between discovery polls whenever signals fail'
      );
    }
    const workspaceHash = this.workspaceStore.workspaceHash;
    this.unsubscribe = this.synClient.onSignal(async synSignal => {
      if (synSignal.type !== 'SessionMessage') return;
      if (isEqual(synSignal.provenance, this.myPubKey)) return;

      const message: SessionMessage = synSignal.message;
      if (
        message &&
        isEqual(message.workspace_hash, workspaceStore.workspaceHash)
      ) {
        if (message.payload.type === 'LeaveSession') {
          this.handleLeaveSessionNotice(synSignal.provenance);
          return;
        }

        if (
          message.payload.type === 'JoinSession' ||
          !get(this._participants).get(synSignal.provenance)
        ) {
          this.handleNewParticipant(synSignal.provenance);
        } else {
          this._participants.update(p => {
            const participantInfo = p.get(synSignal.provenance);
            if (participantInfo) {
              participantInfo.lastSeen = Date.now();
              participantInfo.lastSignalSeen = Date.now();
              p.set(synSignal.provenance, participantInfo);
            }
            return p;
          });
        }

        if (message.payload.type === 'NewCommit') {
          const currentTip = get(this._currentTip);
          const newCommit = new EntryRecord<Commit>(message.payload.new_commit);
          const author =
            message.payload.new_commit.signed_action.hashed.content.author;

          // Merge the commit's state into our local document. The commit
          // carries the full document, so we converge even when its author
          // is no longer reachable for an interactive sync.
          let commitHeads: Automerge.Heads;
          try {
            const commitState = stateFromCommit(
              newCommit.entry
            ) as Automerge.Doc<S>;
            commitHeads = Automerge.getHeads(commitState);
            const state = get(this._state);
            // Skip the merge when our document already contains the
            // commit's changes (the common case: they arrived as deltas
            // through ChangeNotice signals before the commit did)
            if (!this.headsInHistory(state, commitHeads)) {
              // Merge a clone outside the store update: Automerge.merge
              // consumes its target, so a failure mid-merge must not leave
              // the live document frozen
              const next = this.mergeRebuilt(
                Automerge.clone(state, Automerge.getActorId(state)),
                commitState
              );
              this._state.set(next);
            }
          } catch (error) {
            // Don't adopt a tip whose content we couldn't absorb: our next
            // commit would silently drop that content from the history.
            // Leaving our tip alone forks the workspace instead, and the
            // merge path resolves the fork; meanwhile try to converge
            // through an interactive sync.
            console.error('Failed to merge state from incoming commit:', error);
            this.requestSync(author);
            return;
          }

          if (
            currentTip &&
            !newCommit.entry.previous_commit_hashes.find(
              previous_commit =>
                previous_commit.toString() === currentTip.actionHash.toString()
            )
          ) {
            // The commit doesn't descend from our tip: we and its author
            // were committing against different parents. Request a sync so
            // that the author also learns about our changes, and back our
            // own commits off by a jittered window so a retry doesn't
            // collide again.
            this.requestSync(author);
            this._backoffUntil =
              Date.now() +
              Math.random() *
                (this.config.commitStrategy.CommitEveryNMs ?? 10000);
          }

          this._currentTip.set(newCommit);
          this._tipHeads = commitHeads;
          // Refresh the save point and clear the divergence clock if the
          // commit covered our local changes; otherwise the clock keeps
          // running so a non-leader can still take over committing what
          // the leader is missing
          void this.updateSyncStatus();
          return;
        }

        if (message.payload.type === 'ChangeNotice') {
          this.handleChangeNotice(
            synSignal.provenance,
            message.payload.state_changes.map(
              c => decode(c) as Uint8Array
            ),
            message.payload.ephemeral_changes.map(
              c => decode(c) as Uint8Array
            )
          );
        }
        if (message.payload.type === 'SyncReq') {
          this.handleSyncRequest(
            synSignal.provenance,
            message.payload.sync_message
              ? (decode(
                message.payload.sync_message
              ) as Uint8Array)
              : undefined,
            message.payload.ephemeral_sync_message
              ? (decode(
                message.payload.ephemeral_sync_message
              ) as Uint8Array)
              : undefined
          );
        }

        if (message.payload.type === 'Heartbeat') {
          this.handleHeartbeat(
            synSignal.provenance,
            message.payload.known_participants
          );
        }
      }
    });

    const discoveryNewParticipants = setInterval(async () => {
      const participants = await this.synClient.getWorkspaceSessionParticipants(
        workspaceHash
      );

      // Forget departures old enough for the link delete to have propagated.
      // outOfSessionTimeout is a heuristic TTL: if gossip is slower than
      // that, the agent gets re-added as idle until the delete arrives and
      // its lastSeen ages out — bounded, and its rank is protected by the
      // ghostSignalTimeout filter.
      for (const [agentB64, leftAt] of this._recentlyLeft) {
        if (Date.now() - leftAt > config.outOfSessionTimeout) {
          this._recentlyLeft.delete(agentB64);
        }
      }

      this._participants.update(p => {
        for (const link of participants) {
          const agent = retype(link.target, HashType.AGENT);
          if (isEqual(this.myPubKey, agent)) continue;

          const existing = p.get(agent);
          if (existing) {
            // The agent's session link is still in the DHT: count that as
            // presence so that leader election keeps working even when
            // remote signals (heartbeats) aren't getting through
            existing.lastSeen = Date.now();
            p.set(agent, existing);
          } else if (!this._recentlyLeft.has(encodeHashToBase64(agent))) {
            // Skip agents we've just seen leave: their link delete may not
            // have propagated to us yet, and re-adding them would put a
            // gone agent back into the leadership order
            p.set(agent, {
              lastSeen: Date.now(),
              firstSeen: Date.now(),
              lastActive: undefined,
              syncStates: {
                state: Automerge.initSyncState(),
                ephemeral: Automerge.initSyncState(),
              },
            });
            this.requestSync(agent);
          }
        }
        return p;
      });
    }, config.newPeersDiscoveryInterval);
    this.intervals.push(discoveryNewParticipants);

    const heartbeatInterval = setInterval(async () => {
      this.trackViewStability();
      this._participants.update(p => {
        const onlineParticipants = (Array.from(p.entries()) as [AgentPubKey, SessionParticipant][])
          .filter(
            ([_participant, info]) =>
              info.lastSeen &&
              Date.now() - info.lastSeen < config.outOfSessionTimeout
          )
          .map(([p, _]) => p)
          .filter(p => encodeHashToBase64(p) !== encodeHashToBase64(this.myPubKey));

        if (p.size > 0) {
          this.synClient.sendMessage(onlineParticipants, {
            workspace_hash: workspaceHash,
            payload: {
              type: 'Heartbeat',
              known_participants: onlineParticipants,
            },
          });
        }
        return p;
      });
    }, config.heartbeatInterval);
    this.intervals.push(heartbeatInterval);

    const commitInterval = setInterval(async () => {
      // The leader (rank 0) commits whenever there are changes. Other
      // participants only step in when local changes have gone uncommitted
      // past their rank's stagger window, so that a single agent takes over
      // instead of every participant committing on the same tick.
      // Ranks computed from a churning participant view (partitions,
      // rejoins) disagree across agents, so leadership is only exercised
      // once the view has been stable for the settling window, and outside
      // the collision backoff window.
      this.trackViewStability();
      if (!this.viewIsStable() || Date.now() < this._backoffUntil) {
        await this.updateSyncStatus();
        return;
      }
      const rank = this.leadershipRank();
      const staleFallback =
        this._divergedSince !== undefined &&
        Date.now() - this._divergedSince >
          this.config.commitStaggerWindow * rank;
      if (rank === 0 || staleFallback) {
        this._commitChanges();
      } else {
        await this.updateSyncStatus();
      }
    }, this.config.commitStrategy.CommitEveryNMs);
    this.intervals.push(commitInterval);

    this._state = writable(currentState);
    this._currentTip = writable(currentTip);
    // At join, the session state is exactly the resolved tip state
    this._tipHeads = currentTip ? Automerge.getHeads(currentState) : undefined;

    const participantsMap: AgentPubKeyMap<SessionParticipant> =
      new AgentPubKeyMap();

    for (const p of initialParticipants) {
      participantsMap.set(p, {
        lastSeen: Date.now(),
        firstSeen: Date.now(),
        lastActive: this.myPubKey === p ? Date.now() : undefined,
        syncStates: {
          state: Automerge.initSyncState(),
          ephemeral: Automerge.initSyncState(),
        },
      });
    }

    this._participants = writable(participantsMap);

    let eph = Automerge.init() as Automerge.Doc<E>;

    this._ephemeral = writable(eph);

    for (const p of initialParticipants) {
      this.requestSync(p);
    }
  }

  static async joinSession<S, E>(
    workspaceStore: WorkspaceStore<S, E>,
    onLeave: () => void,
    config: SynConfig
  ): Promise<SessionStore<S, E>> {
    const participants =
      await workspaceStore.documentStore.synStore.client.joinWorkspaceSession(
        workspaceStore.workspaceHash
      );

    const currentTip = await toPromise(workspaceStore.tip);
    const currentState: S = await toPromise(workspaceStore.latestSnapshot);
    const sessionStatus: SessionStatus = { code: 'ok', lastSave: currentTip ? new Date(currentTip.action.timestamp).toISOString() : '' };

    return new SessionStore(
      workspaceStore,
      onLeave,
      config,
      currentState as Automerge.Doc<S>,
      currentTip,
      sessionStatus,
      participants
    );
  }

  // Records when the composition of the session (active + idle participants)
  // last changed. Ranks computed from a view that is still settling are not
  // acted on: during partitions and rejoins each agent sees a different,
  // churning participant list and several agents can briefly compute rank 0.
  private trackViewStability() {
    const { active, idle } = get(this.participants);
    const viewKey = [...active, ...idle]
      .map(p => encodeHashToBase64(p))
      .sort()
      .join(',');
    if (viewKey !== this._viewKey) {
      this._viewKey = viewKey;
      this._viewStableSince = Date.now();
    }
  }

  private viewIsStable(): boolean {
    const now = Date.now();
    return (
      now - this._joinedAt >= this.config.viewSettlingWindow &&
      now - this._viewStableSince >= this.config.viewSettlingWindow
    );
  }

  // Whether all the given heads are already part of doc's history, i.e. the
  // doc already contains the changes they describe. Note that
  // Automerge.view() does NOT throw on unknown heads (it silently returns
  // the state at whatever subset exists), so missing-deps is the only
  // reliable containment check.
  private headsInHistory(
    doc: Automerge.Doc<S>,
    heads: Automerge.Heads
  ): boolean {
    return Automerge.getMissingDeps(doc, heads).length === 0;
  }

  // Whether our local document matches the state recorded in the current
  // tip commit. Heads equality is exact and cheap; when heads differ but the
  // tip's heads are part of our history, fall back to comparing content at
  // those heads (histories may differ while content is equal).
  private inSyncWithTip(): boolean {
    if (!this._tipHeads) return false;
    const state = get(this._state);
    const heads = Automerge.getHeads(state);
    if (isEqual([...heads].sort(), [...this._tipHeads].sort())) return true;
    // The tip's heads must be part of our history before view() can give a
    // meaningful answer (view does not throw on unknown heads)
    if (!this.headsInHistory(state, this._tipHeads)) return false;
    const tipView = Automerge.view(state, this._tipHeads);
    return isEqual(Automerge.toJS(tipView), Automerge.toJS(state));
  }

  private async updateSyncStatus() {
    const tip = get(this._currentTip);
    const lastSave = tip
      ? new Date(tip.action.timestamp).toISOString()
      : get(this.sessionStatus).lastSave;
    let inSync: boolean;
    if (this._tipHeads) {
      inSync = this.inSyncWithTip();
    } else {
      // Nothing committed yet: in sync only if we match the initial snapshot
      const latestSnapshot = await toPromise(
        this.workspaceStore.latestSnapshot
      );
      inSync = this.statesEqual(
        latestSnapshot as Automerge.Doc<S>,
        get(this._state)
      );
    }
    if (inSync) {
      this._divergedSince = undefined;
    }
    this._sessionStatus.set({ code: inSync ? 'ok' : 'syncing', lastSave });
  }

  /** Rank of this agent in the leadership order: 0 means leader */
  leadershipRank(): number {
    const { active, idle } = get(this.participants);
    const participants = get(this._participants);
    const now = Date.now();
    // Session links in the DHT keep an agent in the participant list, but
    // only direct signals prove it is actually running: an agent that
    // crashed without leaving would otherwise hold its rank forever
    const liveForLeadership = (p: AgentPubKey) => {
      if (isEqual(p, this.myPubKey)) return true;
      const info = participants.get(p);
      if (!info) return false;
      const freshness = info.lastSignalSeen ?? info.firstSeen ?? 0;
      return now - freshness < this.config.ghostSignalTimeout;
    };
    const sortedParticipants = [...active, ...idle]
      .filter(liveForLeadership)
      .map(p => encodeHashToBase64(p))
      .sort();
    // The participants store guarantees we are in active or idle and the
    // filter always keeps us, so indexOf can't be -1; clamp anyway so a
    // future regression degrades to "I am the leader" instead of a
    // negative stagger window that fires every tick
    return Math.max(
      0,
      sortedParticipants.indexOf(encodeHashToBase64(this.myPubKey))
    );
  }

  amILeader(): boolean {
    return this.leadershipRank() === 0;
  }

  change(updateFn: (state: S, ephemeral: E) => void) {
    this._state.update(state => {
      let newState = state;
      this._ephemeral.update(ephemeralState => {
        let newEphemeralState = ephemeralState;

        newState = Automerge.change(newState, doc => {
          newEphemeralState = Automerge.change(newEphemeralState, eph => {
            updateFn(doc as S, eph as E);
          });
        });

        const stateChanges = Automerge.getChanges(state, newState);
        const ephemeralChanges = Automerge.getChanges(
          ephemeralState,
          newEphemeralState
        );
        this.deltaCount += stateChanges.length;
        if (stateChanges.length > 0 && this._divergedSince === undefined) {
          this._divergedSince = Date.now();
        }
        if (
          this.config.commitStrategy.CommitEveryNDeltas &&
          this.deltaCount > this.config.commitStrategy.CommitEveryNDeltas &&
          this.amILeader() &&
          this.viewIsStable() &&
          Date.now() >= this._backoffUntil &&
          !this.commitInFlight()
        ) {
          this._commitChanges();
          console.log("Committing changes due to delta count.");
        } else if (stateChanges.length > 0) {
          this._sessionStatus.set({ code: 'syncing', lastSave: get(this.sessionStatus).lastSave });
        }

        const participantsArray = Array.from(get(this._participants).keys()) as AgentPubKey[];
        const otherParticipants = participantsArray.filter(
          p => encodeHashToBase64(p) !== encodeHashToBase64(this.myPubKey)
        );

        // Set me to active
        this._participants.update(p => {
            const info = p.get(this.myPubKey);
            if (info) {
                p.set(this.myPubKey, {
                    ...info,
                    lastActive: Date.now(),
                    lastSeen: Date.now(),
                });
            }
            return p;
        });

        this.workspaceStore.documentStore.synStore.client.sendMessage(
          otherParticipants,
          {
            workspace_hash: this.workspaceStore.workspaceHash,
            payload: {
              type: 'ChangeNotice',
              state_changes: stateChanges.map(c => encode(c) as any),
              ephemeral_changes: ephemeralChanges.map(c => encode(c) as any),
            },
          }
        );
        return newEphemeralState;
      });

      return newState;
    });
  }

  private handleChangeNotice(
    from: AgentPubKey,
    stateChanges: Uint8Array[],
    ephemeralChanges: Uint8Array[]
  ) {
    this._participants.update(p => {
        const participantInfo = p.get(from);
        if (participantInfo) {
            participantInfo.lastSeen = Date.now();
            participantInfo.lastSignalSeen = Date.now();
            participantInfo.lastActive = Date.now();
            p.set(from, participantInfo);
        }
        return p;
    });

    this.deltaCount += stateChanges.length;
    if (stateChanges.length > 0 && this._divergedSince === undefined) {
      // Remote uncommitted changes count as divergence too: if their author
      // can't reach the leader, our own takeover clock must cover them
      this._divergedSince = Date.now();
    }

    this._state.update(state => {
      const [updatedState] = Automerge.applyChanges(state, stateChanges);

      return updatedState;
    });

    this._ephemeral.update(ephemeral => {
      const [updatedEphemeral] = Automerge.applyChanges(
        ephemeral,
        ephemeralChanges
      );

      return updatedEphemeral;
    });

    if (stateChanges.length > 0) {
      this._sessionStatus.set({ code: 'syncing', lastSave: get(this.sessionStatus).lastSave });
    }
  }

  requestSync(participant: AgentPubKey) {
    const participantEntry = get(this._participants).get(participant);
    if (!participantEntry) return;
    const syncStates = participantEntry.syncStates;

    const [nextSyncState, syncMessage] = Automerge.generateSyncMessage(
      get(this._state),
      syncStates.state
    );
    const [ephemeralNextSyncState, ephemeralSyncMessage] =
      Automerge.generateSyncMessage(get(this._ephemeral), syncStates.ephemeral);

    this._participants.update(p => {
      const info = p.get(participant);
      if (info) {
        p.set(participant, {
          ...info,
          syncStates: {
            state: nextSyncState,
            ephemeral: ephemeralNextSyncState,
          },
        });
      }
      return p;
    });

    if (syncMessage || ephemeralSyncMessage) {
      this.workspaceStore.documentStore.synStore.client.sendMessage(
        [participant],
        {
          workspace_hash: this.workspaceStore.workspaceHash,
          payload: {
            type: 'SyncReq',
            sync_message: syncMessage ? encode(syncMessage) : undefined,
            ephemeral_sync_message: ephemeralSyncMessage
              ? encode(ephemeralSyncMessage)
              : undefined,
          },
        }
      );
    }
  }

  private handleSyncRequest(
    from: AgentPubKey,
    syncMessage: Uint8Array | undefined,
    ephemeralSyncMessage: Uint8Array | undefined
  ) {
    this._participants.update(p => {
      const participantInfo = p.get(from);
      if (!participantInfo) return p;

      if (syncMessage) {
        this._state.update(state => {
          const [nextDoc, nextSyncState, _message] =
            Automerge.receiveSyncMessage(
              state,
              participantInfo.syncStates.state,
              syncMessage
            );
          const changes = Automerge.getChanges(state, nextDoc);
          this.deltaCount += changes.length;
          if (changes.length > 0 && this._divergedSince === undefined) {
            this._divergedSince = Date.now();
          }

          participantInfo.syncStates.state = nextSyncState;
          return nextDoc;
        });
      }

      if (ephemeralSyncMessage) {
        this._ephemeral.update(ephemeral => {
          const [nextDoc, nextSyncState, _message] =
            Automerge.receiveSyncMessage(
              ephemeral,
              participantInfo.syncStates.ephemeral,
              ephemeralSyncMessage
            );

          participantInfo.syncStates.ephemeral = nextSyncState;

          return nextDoc;
        });
      }

      p.set(from, participantInfo);
      return p;
    });

    this.requestSync(from);
  }

  // All commit attempts are funneled through a single promise chain: two
  // commits running concurrently would read the same tip and produce forked
  // sibling commits that then need a merge commit to resolve.
  private _commitQueue: Promise<unknown> = Promise.resolve();
  private _commitsInFlight = 0;

  private commitInFlight(): boolean {
    return this._commitsInFlight > 0;
  }

  // Public commitChanges: waits for any pending commit and issues a commit
  // afterwards.
  async commitChanges(meta?: any) {
    this._commitsInFlight += 1;
    const run = this._commitQueue.then(() => this.commitChangesInternal(meta));
    // The queue must survive a failed commit; callers see the failure
    // through `run`
    this._commitQueue = run
      .catch(() => {})
      .finally(() => {
        this._commitsInFlight -= 1;
      });
    return run;
  }

  // This is the version of commitChanges that is called by the periodic
  // update manager. If there is already a commit in progress the request is
  // ignored: the pending commit will pick these changes up.
  private _commitChanges(meta?: any) {
    if (this.commitInFlight()) {
      return;
    }
    this.commitChanges(meta).catch(error =>
      console.error('Commit failed in _commitChanges:', error)
    );
  }

  // Merge `other` into `doc` and rebuild the doc through a save/load
  // round-trip. The round-trip works around an automerge bug where merged
  // documents can be left with internal index gaps that later make change
  // commits or sync-message generation panic inside the wasm module
  // (https://github.com/automerge/automerge/issues/1327).
  private mergeRebuilt(
    doc: Automerge.Doc<S>,
    other: Automerge.Doc<S>
  ): Automerge.Doc<S> {
    // Preserve the doc's actor id: load() without one assigns a fresh
    // random actor on every rebuild, accumulating actors in the document
    // metadata over the life of a session
    const actor = Automerge.getActorId(doc);
    const merged = Automerge.merge(doc, other);
    return Automerge.load(Automerge.save(merged), { actor }) as Automerge.Doc<S>;
  }

  // Whether two docs hold the same content, even if their change histories
  // (and therefore their serialized forms) differ
  private statesEqual(a: Automerge.Doc<S>, b: Automerge.Doc<S>): boolean {
    if (isEqual(Automerge.save(a), Automerge.save(b))) return true;
    return isEqual(Automerge.toJS(a), Automerge.toJS(b));
  }

  private notifyNewCommit(newCommit: EntryRecord<Commit>) {
    const otherParticipants = (
      Array.from(get(this._participants).keys()) as AgentPubKey[]
    ).filter(p => !isEqual(p, this.myPubKey));
    this.workspaceStore.documentStore.synStore.client.sendMessage(
      otherParticipants,
      {
        workspace_hash: this.workspaceStore.workspaceHash,
        payload: {
          type: 'NewCommit',
          new_commit: newCommit.record,
        },
      }
    );
  }

  // Record `commit` as our save point: every local change up to it has been
  // persisted to the DHT
  private markSaved(commit: EntryRecord<Commit>) {
    this.deltaCount = 0;
    this._divergedSince = undefined;
    this._sessionStatus.set({
      code: 'ok',
      lastSave: new Date(commit.action.timestamp).toISOString(),
    });
  }

  private async commitChangesInternal(meta?: any) {
    const tipAtStart = get(this._currentTip);
    if (this._tipHeads && tipAtStart) {
      if (this.inSyncWithTip()) {
        // Nothing to commit; refresh the save point so the UI doesn't stay
        // on 'syncing' after content-equal edits (e.g. type then delete)
        this.markSaved(tipAtStart);
        return;
      }
    } else {
      const latestSnapshot = await toPromise(
        this.workspaceStore.latestSnapshot
      );
      if (
        this.statesEqual(latestSnapshot as Automerge.Doc<S>, get(this._state))
      ) {
        // Nothing to commit, just return
        this._divergedSince = undefined;
        this._sessionStatus.set({
          code: 'ok',
          lastSave: get(this.sessionStatus).lastSave,
        });
        return;
      }
    }

    if (meta) {
      meta = encode(meta);
    }

    // Check if there are multiple workspace tips that need to be merged
    const workspaceTips = await this.workspaceStore.getCurrentTips();
    let currentTip = get(this._currentTip);

    if (workspaceTips.length > 1) {
      console.log('Multiple workspace tips detected during session commit, merging:', workspaceTips.map(h => encodeHashToBase64(h)));
      // Merge the tips before creating our commit
      const mergedCommit = await this.workspaceStore.merge(workspaceTips);

      // Bring the merged state into our own document; otherwise the commit
      // below would replace the merge with our pre-merge snapshot. Only
      // adopt the merge commit as our tip once its content is absorbed.
      const mergedState = stateFromCommit(
        mergedCommit.entry
      ) as Automerge.Doc<S>;
      const mergedHeads = Automerge.getHeads(mergedState);
      const state = get(this._state);
      if (!this.headsInHistory(state, mergedHeads)) {
        const next = this.mergeRebuilt(
          Automerge.clone(state, Automerge.getActorId(state)),
          mergedState
        );
        this._state.set(next);
      }

      currentTip = mergedCommit;
      this._currentTip.set(mergedCommit);
      this._tipHeads = mergedHeads;

      // If the merge already contains everything we have locally, the merge
      // commit is the new tip and the only thing to broadcast: there is
      // nothing left to commit. Otherwise skip the intermediate broadcast —
      // the commit below supersedes the merge commit, references it as
      // parent, and carries the merged state. Trade-off: recipients whose
      // tip is a pre-merge commit won't find their tip in the follow-up's
      // previous_commit_hashes and fall back to one requestSync round trip,
      // instead of every participant paying a second full-document
      // broadcast.
      if (this.inSyncWithTip()) {
        this.notifyNewCommit(mergedCommit);
        this.markSaved(mergedCommit);
        return;
      }
    }

    const previous_commit_hashes = currentTip ? [currentTip.actionHash] : [];
    const stateAtCommit = get(this._state);
    const commit: Commit = {
      authors: [
        ...(Array.from(get(this._participants).keys()) as AgentPubKey[]),
        this.synClient.client.myPubKey,
      ],
      meta,
      previous_commit_hashes,
      state: encode(Automerge.save(stateAtCommit)),
      witnesses: [],
      document_hash: this.workspaceStore.documentStore.documentHash,
    };

    try {
      const newCommit = await this.synClient.createCommit(commit);

      this._currentTip.set(newCommit);
      this._tipHeads = Automerge.getHeads(stateAtCommit);
      this.notifyNewCommit(newCommit);

      await this.synClient.updateWorkspaceTip(
        this.workspaceStore.workspaceHash,
        newCommit.actionHash,
        previous_commit_hashes
      );

      this.markSaved(newCommit);
    } catch (error) {
      console.error('Error committing changes:', error);
      this._sessionStatus.set({ code: 'error', error: (error as Error)?.message, lastSave: get(this.sessionStatus).lastSave });
      throw error;
    }
  }

  private handleHeartbeat(_from: AgentPubKey, participants: AgentPubKey[]) {
    this._participants.update(p => {
      const newParticipants = participants.filter(
        maybeNew => !p.has(maybeNew) && !isEqual(maybeNew, this.myPubKey)
      );

      for (const newParticipant of newParticipants) {
        p.set(newParticipant, {
          lastSeen: undefined,
          firstSeen: Date.now(),
          lastActive: undefined,
          syncStates: {
            state: Automerge.initSyncState(),
            ephemeral: Automerge.initSyncState(),
          },
        });

        this.requestSync(newParticipant);
      }

      return p;
    });
  }

  async leaveSession(): Promise<void> {
    const participants = get(this.participants).active;

    if (participants.length === 1) {
      await this.commitChanges();
      console.log('Committed changes before leaving session');
    }

    await this.synClient.leaveWorkspaceSession(
      this.workspaceStore.workspaceHash
    );
    this.unsubscribe();
    for (const interval of this.intervals) {
      clearInterval(interval);
    }
    this.onLeave();
  }

  private handleNewParticipant(participant: AgentPubKey) {
    // A direct signal from the agent: if we recently saw it leave, it has
    // rejoined
    this._recentlyLeft.delete(encodeHashToBase64(participant));
    this._participants.update(p => {
      p.set(participant, {
        lastSeen: Date.now(),
        lastSignalSeen: Date.now(),
        firstSeen: Date.now(),
        lastActive: undefined,
        syncStates: {
          state: Automerge.initSyncState(),
          ephemeral: Automerge.initSyncState(),
        },
      });
      return p;
    });
    this.requestSync(participant);
  }

  private handleLeaveSessionNotice(participant: AgentPubKey) {
    // Remember the departure: the discovery poll may keep seeing the
    // agent's session link until the link delete propagates to us, and
    // must not re-add them
    this._recentlyLeft.set(encodeHashToBase64(participant), Date.now());
    this._participants.update(p => {
      p.delete(participant);
      return p;
    });
  }
}
