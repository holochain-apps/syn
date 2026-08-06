use hdi::prelude::*;

/// Like a branch in git
#[hdk_entry_helper]
#[derive(Clone)]
pub struct Workspace {
    pub document_hash: EntryHash,
    pub name: String,
}

/// The tag carried by every WorkspaceToTip link: the commits this tip
/// supersedes. get_workspace_tips prunes superseded tips with it, so
/// validation requires it to parse.
#[derive(Serialize, Deserialize, Debug, SerializedBytes)]
pub struct PreviousCommitsTag(pub Vec<ActionHash>);
