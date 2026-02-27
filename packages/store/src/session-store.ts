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
  syncStates: { state: Automerge.SyncState; ephemeral: Automerge.SyncState };
}

export class SessionStore<S, E> implements SliceStore<S, E> {
  get workspace() {
    return this.workspaceStore;
  }

  _participants: Writable<AgentPubKeyMap<SessionParticipant>>;
  get participants() {
    return derived(this._participants, i => {
      const isActive = (lastSeen: number | undefined) =>
        lastSeen && Date.now() - lastSeen < this.config.hearbeatInterval * 10;
      const isIdle = (lastSeen: number | undefined) =>
        lastSeen &&
        !isActive(lastSeen) &&
        Date.now() - lastSeen < this.config.outOfSessionTimeout;
      const isOffline = (lastSeen: number | undefined) =>
        !lastSeen || Date.now() - lastSeen > this.config.outOfSessionTimeout;

      const entries = Array.from(i.entries()) as [AgentPubKey, SessionParticipant][];

      const active = entries
        .filter(
          ([pubkey, info]) =>
            isActive(info.lastSeen) && !isEqual(pubkey, this.myPubKey)
        )
        .map(([pubkey, _]) => pubkey);
      active.push(this.myPubKey);

      const idle = entries
        .filter(([_, info]) => isIdle(info.lastSeen))
        .map(([pubkey, _]) => pubkey);
      const offline = entries
        .filter(([_, info]) => isOffline(info.lastSeen))
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
          let newCommit = new EntryRecord<Commit>(message.payload.new_commit);

          if (
            currentTip &&
            !newCommit.entry.previous_commit_hashes.find(
              previous_commit =>
                previous_commit.toString() === currentTip.actionHash.toString()
            )
          ) {
            // We are out of sync with the author of the commit: sync again
            this.requestSync(message.payload.new_commit.signed_action.hashed.content.author);

            // TODO: This was old merge conflict management, lead to many commits being created
            // What to do about this?

            // newCommit = await this.workspaceStore.merge([
            //   currentTip.actionHash,
            //   newCommit.actionHash,
            // ]);

            // this.workspaceStore.documentStore.synStore.client.sendMessage(
            //   Array.from(get(this._participants).keys()),
            //   {
            //     workspace_hash: this.workspaceStore.workspaceHash,
            //     payload: {
            //       type: 'NewCommit',
            //       new_commit: newCommit.record,
            //     },
            //   }
            // );
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
        const newParticipants = participants.filter(
          maybeNew =>
            !p.has(retype(maybeNew.target, HashType.AGENT)) &&
            !isEqual(this.myPubKey, retype(maybeNew.target, HashType.AGENT))
        );

        for (const newParticipant of newParticipants) {
          p.set(retype(newParticipant.target, HashType.AGENT), {
            lastSeen: Date.now(),
            syncStates: {
              state: Automerge.initSyncState(),
              ephemeral: Automerge.initSyncState(),
            },
          });

          this.requestSync(retype(newParticipant.target, HashType.AGENT));
        }
        return p;
      });
    }, config.newPeersDiscoveryInterval * 10);
    this.intervals.push(discoveryNewParticipants);

    if (config.enablePresenceHeartbeat && config.hearbeatInterval > 0) {
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
      }, config.hearbeatInterval);
      this.intervals.push(heartbeatInterval);
    }

    const commitInterval = setInterval(async () => {
      if (
        this.amILeader() ||
        (get(this._sessionStatus).lastSave && (Date.now() - new Date(get(this._sessionStatus).lastSave!).getTime()) > 1000 * 60)
      ) {
        this._commitChanges();
        console.log('Committing changes due to periodic interval');
      } else {
        const lastSave = await toPromise(this.workspaceStore.tip);
        const latestSnapshot = await toPromise(this.workspaceStore.latestSnapshot);
        let inSync = isEqual(
          Automerge.save(latestSnapshot as Automerge.Doc<S>),
          Automerge.save(get(this._state))
        );

        // Double check by comparing the full object trees (more expensive)
        if (!inSync) {
          inSync = isEqual(
            Automerge.toJS(latestSnapshot as Automerge.Doc<S>),
            Automerge.toJS(get(this._state))
          );
        }
        const code = inSync ? 'ok' : 'syncing';
        this._sessionStatus.set({ code, lastSave: (lastSave ? new Date(lastSave.action.timestamp).toISOString() : '') });
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

  amILeader(): boolean {
    const activeParticipants = get(this.participants).active
      .map(p => encodeHashToBase64(p))
      .sort((p1, p2) => {
        if (p1 < p2) {
          return -1;
        }
        if (p1 > p2) {
          return 1;
        }
        return 0;
      });

    return activeParticipants[0] === encodeHashToBase64(this.myPubKey);
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
    _from: AgentPubKey,
    stateChanges: Uint8Array[],
    ephemeralChanges: Uint8Array[]
  ) {
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
    if (this._previousCommitPromise) await this._previousCommitPromise;
    this._previousCommitPromise = this.commitChangesInternal(meta);

    return this._previousCommitPromise;
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

  private async commitChangesInternal(meta?: any) {
    const latestSnapshot = await toPromise(this.workspaceStore.latestSnapshot);

    if (
      isEqual(
        Automerge.save(latestSnapshot as Automerge.Doc<S>),
        Automerge.save(get(this._state))
      )
    ) {
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
      console.log('New commit created');

      this._currentTip.set(newCommit);
      const otherParticipants = (Array.from(get(this._participants).keys()) as AgentPubKey[]).filter(
        p => !isEqual(p, this.myPubKey)
      );
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
