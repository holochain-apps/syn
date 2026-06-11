import { AgentPubKey } from '@holochain/client';
import { SessionStore } from '@holochain-syn/store';

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
  condition: () => boolean,
  timeoutMs: number,
  intervalMs = 500
) {
  const rounds = Math.ceil(timeoutMs / intervalMs);
  for (let i = 0; i < rounds; i++) {
    if (condition()) return true;
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
