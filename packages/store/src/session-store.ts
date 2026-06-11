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
  lastSeen: number | undefined;
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
              p.set(synSignal.provenance, participantInfo);
            }
            return p;
          });
        }

        if (message.payload.type === 'NewCommit') {
          const currentTip = get(this._currentTip);
          const newCommit = new EntryRecord<Commit>(message.payload.new_commit);

          // Merge the commit's state into our local document. The commit
          // carries the full document, so we converge even when its author
          // is no longer reachable for an interactive sync.
          try {
            const commitState = Automerge.load(
              decode(newCommit.entry.state) as Uint8Array
            ) as Automerge.Doc<S>;
            this._state.update(state => Automerge.merge(state, commitState));
          } catch (error) {
            console.error('Failed to merge state from incoming commit:', error);
          }

          if (
            currentTip &&
            !newCommit.entry.previous_commit_hashes.find(
              previous_commit =>
                previous_commit.toString() === currentTip.actionHash.toString()
            )
          ) {
            // The commit doesn't descend from our tip: request a sync so that
            // the author also learns about our changes
            this.requestSync(message.payload.new_commit.signed_action.hashed.content.author);
          }

          this._currentTip.set(newCommit);
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
          } else {
            p.set(agent, {
              lastSeen: Date.now(),
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
      // participants only step in when saves have gone stale, each rank
      // waiting progressively longer so that a single agent takes over
      // instead of every participant committing on the same tick.
      const rank = this.leadershipRank();
      const lastSave = get(this._sessionStatus).lastSave;
      const staleSaveFallback =
        rank > 0 &&
        !!lastSave &&
        Date.now() - new Date(lastSave).getTime() > 1000 * 60 * rank;
      if (rank === 0 || staleSaveFallback) {
        this._commitChanges();
      } else {
        const tip = await toPromise(this.workspaceStore.tip);
        const latestSnapshot = await toPromise(this.workspaceStore.latestSnapshot);
        const inSync = this.statesEqual(
          latestSnapshot as Automerge.Doc<S>,
          get(this._state)
        );
        const code = inSync ? 'ok' : 'syncing';
        this._sessionStatus.set({ code, lastSave: (tip ? new Date(tip.action.timestamp).toISOString() : '') });
      }
    }, this.config.commitStrategy.CommitEveryNMs);
    this.intervals.push(commitInterval);

    this._state = writable(currentState);
    this._currentTip = writable(currentTip);

    const participantsMap: AgentPubKeyMap<SessionParticipant> =
      new AgentPubKeyMap();

    for (const p of initialParticipants) {
      participantsMap.set(p, {
        lastSeen: Date.now(),
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

  /** Rank of this agent in the leadership order: 0 means leader */
  leadershipRank(): number {
    const { active, idle } = get(this.participants);
    const sortedParticipants = [...active, ...idle]
      .map(p => encodeHashToBase64(p))
      .sort();
    const rank = sortedParticipants.indexOf(encodeHashToBase64(this.myPubKey));
    return rank === -1 ? sortedParticipants.length : rank;
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
        if (
          this.config.commitStrategy.CommitEveryNDeltas &&
          this.deltaCount > this.config.commitStrategy.CommitEveryNDeltas &&
          this.amILeader() &&
          !this._previousCommitPromise
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
            participantInfo.lastActive = Date.now();
            p.set(from, participantInfo);
        }
        return p;
    });

    this.deltaCount += stateChanges.length;

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

  _previousCommitPromise: Promise<void> | undefined;

  // This is the version public version of commitChanges that will
  // await for any pending commit and issue a commit afterwards.
  async commitChanges(meta?: any) {
    if (this._previousCommitPromise) {
      try {
        await this._previousCommitPromise;
      } catch (error) {
        // the previous commit failed; still attempt this one
      }
    }
    const commitPromise = this.commitChangesInternal(meta);
    this._previousCommitPromise = commitPromise;

    try {
      return await commitPromise;
    } finally {
      this._previousCommitPromise = undefined;
    }
  }

  // This is the version of commitChanges that is called by the
  // periodic update manager.  if there is allready a commit in progress
  // the request is ignored and it is assumed that it will be completed
  // later
  private async _commitChanges(meta?: any) {
    if (this._previousCommitPromise) {
      return;
    }

    this._previousCommitPromise = this.commitChangesInternal(meta);
    
    try {
      await this._previousCommitPromise;
    } catch (error) {
      console.error('Commit failed in _commitChanges:', error);
    } finally {
      this._previousCommitPromise = undefined;
    }
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

  private async commitChangesInternal(meta?: any) {
    const latestSnapshot = await toPromise(this.workspaceStore.latestSnapshot);

    if (this.statesEqual(latestSnapshot as Automerge.Doc<S>, get(this._state))) {
      // Nothing to commit, just return
      return;
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
      currentTip = mergedCommit;
      this._currentTip.set(mergedCommit);

      // Bring the merged state into our own document; otherwise the commit
      // below would replace the merge with our pre-merge snapshot
      const mergedState = Automerge.load(
        decode(mergedCommit.entry.state) as Uint8Array
      ) as Automerge.Doc<S>;
      this._state.update(state => Automerge.merge(state, mergedState));

      this.notifyNewCommit(mergedCommit);

      // If the merge already contains everything we have locally, the merge
      // commit is the new tip: there is nothing left to commit
      if (this.statesEqual(mergedState, get(this._state))) {
        this.deltaCount = 0;
        this._sessionStatus.set({
          code: 'ok',
          lastSave: new Date(mergedCommit.action.timestamp).toISOString(),
        });
        return;
      }
    }

    const previous_commit_hashes = currentTip ? [currentTip.actionHash] : [];
    const commit: Commit = {
      authors: [
        ...(Array.from(get(this._participants).keys()) as AgentPubKey[]),
        this.synClient.client.myPubKey,
      ],
      meta,
      previous_commit_hashes,
      state: encode(Automerge.save(get(this._state))),
      witnesses: [],
      document_hash: this.workspaceStore.documentStore.documentHash,
    };

    try {
      const newCommit = await this.synClient.createCommit(commit);

      this._currentTip.set(newCommit);
      this.notifyNewCommit(newCommit);

      await this.synClient.updateWorkspaceTip(
        this.workspaceStore.workspaceHash,
        newCommit.actionHash,
        previous_commit_hashes
      );

      this.deltaCount = 0;
      this._sessionStatus.set({ code: 'ok', lastSave: new Date(newCommit.action.timestamp).toISOString()});
    } catch (error) {
      console.error('Error committing changes:', error);
      this._previousCommitPromise = undefined;
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
    this._participants.update(p => {
      p.set(participant, {
        lastSeen: Date.now(),
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
    this._participants.update(p => {
      p.delete(participant);
      return p;
    });
  }
}
