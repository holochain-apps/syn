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
 *
 * Migration note: the compatibility is one-way. Pre-envelope clients read
 * every commit as a bare snapshot binary, so the first delta commit written
 * to a shared DHT is unreadable to them (they fail on the envelope rather
 * than skipping it). Roll out this client version to a network before
 * relying on delta commits, or keep old clients off shared documents.
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
    // Reject envelopes from a newer format version: their `data` may have
    // different semantics, and feeding them to loadIncremental would apply
    // unknown bytes. Throwing routes the caller to its existing safe path
    // (skip the tip, converge through sync and DHT reconstruction).
    if (envelope.v !== COMMIT_PAYLOAD_VERSION) {
      throw new Error(
        `Unsupported commit payload version ${envelope.v} (this client understands v${COMMIT_PAYLOAD_VERSION})`
      );
    }
    return {
      kind: 'delta',
      data: envelope.data,
      heads: envelope.heads,
      depth: envelope.depth,
    };
  }
  throw new Error('Unrecognized commit payload format');
}
