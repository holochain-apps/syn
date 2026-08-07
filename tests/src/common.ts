import { AgentPubKey } from '@holochain/client';
import { SessionStore } from '@holochain-syn/store';
import { get } from '@holochain-open-dev/stores';

import {
  TextEditorEphemeralState,
  textEditorGrammar,
  TextEditorState,
} from './text-editor-grammar.js';

export const synHapp = process.cwd() + '/../workdir/syn-test.happ';

export type Add = [number, string];
export type Delete = [number, number];
export type Title = string;

// Signal type definitions
export type Delta = {
  type: string;
  value: Add | Delete | Title;
};

export type Signal = {
  sessionHash: string;
  message: {
    type: string;
    payload: any;
  };
};

export const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Poll `condition` every `intervalMs` until it holds or `timeoutMs` runs
 *  out; returns the final value of the condition. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500
) {
  const rounds = Math.ceil(timeoutMs / intervalMs);
  for (let i = 0; i < rounds; i++) {
    if (await condition()) return true;
    await delay(intervalMs);
  }
  return condition();
}

/*
  Fake UI functions
    - applyDeltas
      - takes a content and a list of deltas
      - returns the new content with those deltas applied
*/

export interface Content extends Record<string, unknown> {
  title: string;
  body: TextEditorState;
}

export const sampleGrammar = {
  initialState(): Content {
    return {
      title: '',
      body: textEditorGrammar.initialState(),
    };
  },

  changes(
    myPubKey: AgentPubKey,
    state: Content,
    eph: TextEditorEphemeralState
  ) {
    return {
      setTitle(title: string) {
        state.title = title;
      },
      ...textEditorGrammar.changes(myPubKey, state.body, eph),
    };
  },
};

/** Prove the session's live document is still operable: a poisoned wasm
 *  handle (automerge panic mid-operation) throws "recursive use of an object
 *  detected" on any further read or write. Performs a content-neutral
 *  write+revert, a state read, and checks the session status. */
export function assertSessionHealthy(
  store: SessionStore<any, any>,
  pubKey: AgentPubKey,
  label = 'session'
) {
  try {
    get(store.state);
    // insert+revert in ONE transaction: two separate change() calls leave
    // a window where a remote change shifts index 0 and the delete would
    // remove a remote character, breaking later convergence assertions
    store.change((state: any, eph: any) => {
      const changes = textEditorGrammar.changes(pubKey, state.body, eph);
      changes.insert(0, ' ');
      changes.delete(0, 1);
    });
  } catch (e) {
    throw new Error(`${label} document is poisoned or unusable: ${e}`);
  }
  const status = get(store.sessionStatus);
  if (status.code === 'error') {
    throw new Error(`${label} status is 'error'`);
  }
}

export function waitForOtherParticipants(
  sessionStore: SessionStore<any, any>,
  otherParticipants: number,
  timeout = 600000
) {
  return new Promise((resolve, reject) => {
    sessionStore.participants.subscribe(p => {
      if (
        p.active.filter(p => p.toString() !== sessionStore.myPubKey.toString())
          .length >= otherParticipants
      ) {
        resolve(undefined);
      }
    });
    setTimeout(() => reject('Timeout'), timeout);
  });
}
