use hdi::prelude::*;

/// The document state carried by a commit.
///
/// Kept as a tagged enum in the entry itself so integrity validation can
/// distinguish snapshots from deltas, and so clients never need to sniff an
/// opaque envelope out of raw bytes.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommitState {
    /// A full serialization of the document (`Automerge.save()`)
    Snapshot { data: SerializedBytes },
    /// The changes on top of the parent commit (`Automerge.saveSince()`)
    Delta {
        data: SerializedBytes,
        /// The document's heads at commit time
        heads: Vec<String>,
        /// Number of delta commits since the last snapshot; bounds the chain
        /// walk needed to reconstruct the document
        depth: u32,
    },
}

#[hdk_entry_helper]
#[derive(Clone)]
pub struct Commit {
    pub state: CommitState,

    pub document_hash: EntryHash,
    pub previous_commit_hashes: Vec<ActionHash>,

    pub authors: Vec<AgentPubKey>,

    pub meta: Option<SerializedBytes>,
}
