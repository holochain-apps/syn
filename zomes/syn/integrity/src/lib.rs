mod commit;
mod document;
mod workspace;

pub use commit::*;
pub use document::*;
pub use workspace::*;

use hdi::prelude::*;

#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
pub enum EntryTypes {
    Document(Document),
    Workspace(Workspace),
    Commit(Commit),
}

#[derive(Serialize, Deserialize)]
#[hdk_link_types]
pub enum LinkTypes {
    TagToDocument,
    DocumentToAuthors,
    DocumentToWorkspaces,
    DocumentToCommits,
    WorkspaceToTip,
    WorkspaceToParticipant,
}

fn invalid(reason: impl Into<String>) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(reason.into()))
}

/// Fetch the Commit at `commit_action_hash`. Outer Err means the record is a
/// missing dependency (retry); inner Err means the record exists but is not
/// a Commit — deterministic garbage the caller must mark Invalid.
fn get_commit(commit_action_hash: ActionHash) -> ExternResult<Result<Commit, String>> {
    let commit_record = must_get_valid_record(commit_action_hash)?;
    match commit_record.entry().to_app_option::<Commit>() {
        Ok(Some(commit)) => Ok(Ok(commit)),
        _ => Ok(Err(
            "target does not resolve to a Commit entry".to_string()
        )),
    }
}

fn commit_depth(commit: &Commit) -> u32 {
    match &commit.state {
        CommitState::Snapshot { .. } => 0,
        CommitState::Delta { depth, .. } => *depth,
    }
}

/// The referenced document entry must exist and deserialize as a Document
fn validate_document_ref(document_hash: EntryHash) -> ExternResult<ValidateCallbackResult> {
    let document_entry = must_get_entry(document_hash)?;
    match crate::Document::try_from(document_entry) {
        Ok(_) => Ok(ValidateCallbackResult::Valid),
        Err(_) => invalid("document_hash does not reference a Document entry"),
    }
}

fn validate_commit(commit: &Commit) -> ExternResult<ValidateCallbackResult> {
    if let ValidateCallbackResult::Invalid(reason) =
        validate_document_ref(commit.document_hash.clone())?
    {
        return invalid(reason);
    }

    if let CommitState::Delta { .. } = commit.state {
        if commit.previous_commit_hashes.is_empty() {
            return invalid("Delta commits must reference at least one previous commit");
        }
    }

    for previous_commit_hash in commit.previous_commit_hashes.iter() {
        let previous_commit = match get_commit(previous_commit_hash.clone())? {
            Ok(previous_commit) => previous_commit,
            Err(reason) => return invalid(reason),
        };
        if previous_commit.document_hash != commit.document_hash {
            return invalid("Previous commit does not reference the same document_hash");
        }
        if let CommitState::Delta { depth, .. } = &commit.state {
            // Delta parents are the current tip group: concurrently authored
            // identical entries that all share one depth. The induction
            // (snapshot = 0, each delta = parent + 1) is what makes depth
            // trustworthy without walking chains during validation.
            if *depth != commit_depth(&previous_commit) + 1 {
                return invalid(format!(
                    "Delta commit depth ({}) must be one more than its parent's depth ({})",
                    depth,
                    commit_depth(&previous_commit)
                ));
            }
        }
    }
    Ok(ValidateCallbackResult::Valid)
}

/// Syn entries are immutable: commits, workspaces and documents are only
/// ever created. An update or delete of one is invalid no matter who
/// authors it — otherwise a hostile agent could publish a Commit through
/// update_entry and bypass validate_commit entirely.
fn validate_delete_of_entry(deletes_address: ActionHash) -> ExternResult<ValidateCallbackResult> {
    let original = must_get_valid_record(deletes_address)?;
    let Some(EntryType::App(app_entry_def)) = original.action().entry_type() else {
        // agent keys, cap grants/claims: not defined by this zome
        return Ok(ValidateCallbackResult::Valid);
    };
    let Some(entry) = original.entry().as_option() else {
        return Ok(ValidateCallbackResult::Valid);
    };
    match EntryTypes::deserialize_from_type(app_entry_def.zome_index, app_entry_def.entry_index, entry)? {
        Some(_) => invalid("Syn entries are immutable and may not be deleted"),
        None => Ok(ValidateCallbackResult::Valid),
    }
}

fn validate_create_link(
    link_type: LinkTypes,
    action: &TypedAction<CreateLinkData>,
) -> ExternResult<ValidateCallbackResult> {
    let author = action.author();
    let base_address = action.base_address.clone();
    let target_address = action.target_address.clone();
    match link_type {
        LinkTypes::TagToDocument => {
            let Some(document_hash) = target_address.into_entry_hash() else {
                return invalid("TagToDocument target must be an entry hash");
            };
            validate_document_ref(document_hash)
        },
        LinkTypes::DocumentToAuthors => {
            // Authorship is claims-based by design: whoever writes a commit
            // links every one of its authors (the session participants), so
            // the link author is intentionally not required to be the target
            if target_address.into_agent_pub_key().is_none() {
                return invalid("DocumentToAuthors target must be an agent public key");
            }
            let Some(document_hash) = base_address.into_entry_hash() else {
                return invalid("DocumentToAuthors base must be an entry hash");
            };
            validate_document_ref(document_hash)
        },
        LinkTypes::DocumentToWorkspaces => {
            // make sure workspace references document it is linking from
            let Some(workspace_hash) = target_address.into_entry_hash() else {
                return invalid("DocumentToWorkspaces target must be an entry hash");
            };
            let Some(document_hash) = base_address.into_entry_hash() else {
                return invalid("DocumentToWorkspaces base must be an entry hash");
            };
            let workspace_entry = must_get_entry(workspace_hash)?;
            let Ok(workspace) = crate::Workspace::try_from(workspace_entry) else {
                return invalid("DocumentToWorkspaces target does not resolve to a Workspace entry");
            };
            if workspace.document_hash != document_hash {
                return invalid(format!(
                    "Workspace document_hash ({:?}) does not match the document being linked from ({:?})",
                    workspace.document_hash, document_hash
                ));
            }
            validate_document_ref(document_hash)
        },
        LinkTypes::DocumentToCommits => {
            // make sure commit references document it is linking from
            let Some(commit_action_hash) = target_address.into_action_hash() else {
                return invalid("DocumentToCommits target must be an action hash");
            };
            let commit = match get_commit(commit_action_hash)? {
                Ok(commit) => commit,
                Err(reason) => return invalid(reason),
            };
            let Some(document_hash) = base_address.into_entry_hash() else {
                return invalid("DocumentToCommits base must be an entry hash");
            };
            if commit.document_hash != document_hash {
                return invalid(
                    "Commit document_hash does not match the document being linked from",
                );
            }
            Ok(ValidateCallbackResult::Valid)
        },
        LinkTypes::WorkspaceToTip => {
            // the tag drives tip pruning, so it must parse for everyone
            let tag_bytes = SerializedBytes::from(UnsafeBytes::from(action.tag.clone().into_inner()));
            if PreviousCommitsTag::try_from(tag_bytes).is_err() {
                return invalid("WorkspaceToTip tag must encode a PreviousCommitsTag");
            }
            // make sure workspace references the same document as the tip commit
            let Some(commit_action_hash) = target_address.into_action_hash() else {
                return invalid("WorkspaceToTip target must be an action hash");
            };
            let commit = match get_commit(commit_action_hash)? {
                Ok(commit) => commit,
                Err(reason) => return invalid(reason),
            };
            let Some(workspace_entry_hash) = base_address.into_entry_hash() else {
                return invalid("WorkspaceToTip base must be an entry hash");
            };
            let workspace_entry = must_get_entry(workspace_entry_hash)?;
            let Ok(workspace) = crate::Workspace::try_from(workspace_entry) else {
                return invalid("WorkspaceToTip base does not resolve to a Workspace entry");
            };
            if commit.document_hash != workspace.document_hash {
                return invalid(format!(
                    "Commit document_hash ({:?}) does not match the document_hash ({:?}) of the workspace being linked to",
                    commit.document_hash, workspace.document_hash
                ));
            }
            Ok(ValidateCallbackResult::Valid)
        },
        LinkTypes::WorkspaceToParticipant => {
            // an agent may only declare their own participation in a session
            match target_address.into_agent_pub_key() {
                Some(agent) if agent == *author => Ok(ValidateCallbackResult::Valid),
                Some(_) => invalid(
                    "WorkspaceToParticipant links may only target the agent that creates them",
                ),
                None => invalid("WorkspaceToParticipant target must be an agent public key"),
            }
        },
    }
}

fn validate_delete_link(
    link_type: LinkTypes,
    author: &AgentPubKey,
    create_author: &AgentPubKey,
) -> ExternResult<ValidateCallbackResult> {
    match link_type {
        LinkTypes::WorkspaceToParticipant => {
            // only the participant themselves may retract their session link
            if author == create_author {
                Ok(ValidateCallbackResult::Valid)
            } else {
                invalid("WorkspaceToParticipant links may only be deleted by their author")
            }
        },
        _ => Ok(ValidateCallbackResult::Valid),
    }
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        FlatOp::CreateRecord(store_record) => match store_record {
            OpRecord::CreateEntry {
                app_entry,
                action: _,
            } => match app_entry {
                EntryTypes::Commit(commit) => validate_commit(&commit),
                _ => Ok(ValidateCallbackResult::Valid),
            },
            OpRecord::UpdateEntry { .. } | OpRecord::UpdatePrivateEntry { .. } => {
                invalid("Syn entries are immutable and may not be updated")
            },
            OpRecord::DeleteEntry { action } => {
                validate_delete_of_entry(action.data.deletes_address.clone())
            },
            // Run the link rules at the record authority too, so a link
            // action is never stored anywhere without them
            OpRecord::CreateLink { link_type, action } => {
                validate_create_link(link_type, &action)
            },
            OpRecord::DeleteLink { action } => {
                let original = must_get_valid_record(action.data.link_add_address.clone())?;
                let ActionData::CreateLink(create_link) = &original.action().data else {
                    return invalid("DeleteLink must reference a CreateLink action");
                };
                match LinkTypes::from_type(create_link.zome_index, create_link.link_type)? {
                    Some(link_type) => validate_delete_link(
                        link_type,
                        action.author(),
                        original.action().author(),
                    ),
                    // another zome's link type
                    None => Ok(ValidateCallbackResult::Valid),
                }
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::CreateEntry(store_entry) => match store_entry {
            OpEntry::CreateEntry {
                app_entry,
                action: _,
            } => match app_entry {
                EntryTypes::Commit(commit) => validate_commit(&commit),
                _ => Ok(ValidateCallbackResult::Valid),
            },
            OpEntry::UpdateEntry { .. } => {
                invalid("Syn entries are immutable and may not be updated")
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::Update(op_update) => match op_update {
            OpUpdate::Entry { .. } | OpUpdate::PrivateEntry { .. } => {
                invalid("Syn entries are immutable and may not be updated")
            },
            _ => Ok(ValidateCallbackResult::Valid),
        },
        FlatOp::AgentActivity(_) => Ok(ValidateCallbackResult::Valid),
        FlatOp::Link(op_link) => match op_link {
            OpLink::CreateLink { link_type, action } => validate_create_link(link_type, &action),
            OpLink::DeleteLink {
                original_action,
                link_type,
                action,
            } => validate_delete_link(link_type, action.author(), original_action.author()),
        },
        FlatOp::Delete(op_delete) => {
            validate_delete_of_entry(op_delete.action.data.deletes_address.clone())
        },
    }
}
