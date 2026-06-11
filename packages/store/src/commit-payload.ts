import { decode, encode } from '@msgpack/msgpack';

/**
 * Encoding of the `state` field of a Commit entry.
 *
 * Snapshots keep the pre-envelope encoding (a bare msgpack binary holding a
 * full `Automerge.save()`), so commits written by older clients decode as
 * snapshots and snapshots written by this client remain readable by them.
 * Deltas are a versioned envelope holding `Automerge.saveSince()` bytes,
 * the heads of the document at commit time, and the number of delta commits
 * since the last snapshot (so readers know the maximum walk-back length).
 */
export type CommitPayload =
  | { kind: 'snapshot'; data: Uint8Array }
  | { kind: 'delta'; data: Uint8Array; heads: string[]; depth: number };

export const COMMIT_PAYLOAD_VERSION = 2;

interface DeltaEnvelope {
  v: number;
  kind: 'delta';
  data: Uint8Array;
  heads: string[];
  depth: number;
}

export function encodeCommitPayload(payload: CommitPayload): Uint8Array {
  if (payload.kind === 'snapshot') {
    return encode(payload.data);
  }
  const envelope: DeltaEnvelope = {
    v: COMMIT_PAYLOAD_VERSION,
    kind: 'delta',
    data: payload.data,
    heads: payload.heads,
    depth: payload.depth,
  };
  return encode(envelope);
}

export function decodeCommitPayload(state: Uint8Array): CommitPayload {
  const decoded = decode(state);
  if (decoded instanceof Uint8Array) {
    return { kind: 'snapshot', data: decoded };
  }
  const envelope = decoded as DeltaEnvelope;
  if (
    envelope &&
    typeof envelope === 'object' &&
    envelope.kind === 'delta' &&
    envelope.data instanceof Uint8Array &&
    Array.isArray(envelope.heads) &&
    typeof envelope.depth === 'number'
  ) {
    return {
      kind: 'delta',
      data: envelope.data,
      heads: envelope.heads,
      depth: envelope.depth,
    };
  }
  throw new Error('Unrecognized commit payload format');
}
