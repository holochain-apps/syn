use std::collections::HashMap;

use hc_zome_syn_integrity::*;
use hdk::prelude::*;
use itertools::Itertools;

use crate::{
    messages::{send_message, MessagePayload, SendMessageInput, SessionMessage},
    utils::{create_link_relaxed, create_relaxed, delete_link_relaxed, ZomeFnInput},
};

#[derive(Serialize, Deserialize, Debug, SerializedBytes)]
pub struct DocumentToWorkspaceTag {
    workspace_name: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct CreateWorkspaceInput {
    workspace: Workspace,
    initial_commit_hash: Option<ActionHash>,
}

#[hdk_extern]
pub fn create_workspace(input: CreateWorkspaceInput) -> ExternResult<Record> {
    let entry_hash = hash_entry(&input.workspace)?;
    let action_hash = create_relaxed(
        EntryTypes::Workspace(input.workspace.clone()),
        input.workspace.clone().try_into()?,
    )?;

    create_link_relaxed(
        input.workspace.document_hash,
        entry_hash.clone(),
        LinkTypes::DocumentToWorkspaces,
        SerializedBytes::try_from(DocumentToWorkspaceTag {
            workspace_name: input.workspace.name,
        })
        .map_err(|err| wasm_error!(err))?
        .bytes()
        .clone(),
    )?;

    if let Some(commit_hash) = input.initial_commit_hash {
        let tag = SerializedBytes::try_from(PreviousCommitsTag(vec![]))
            .map_err(|err| wasm_error!(err))?;
        create_link_relaxed(
            entry_hash,
            commit_hash,
            LinkTypes::WorkspaceToTip,
            tag.bytes().clone(),
        )?;
    }

    let record = get(action_hash, GetOptions::local())?;

    record.ok_or(wasm_error!(WasmErrorInner::Guest(String::from(
        "Could not get the record created just now"
    ))))
}

#[hdk_extern]
pub fn get_workspace(workspace_hash: EntryHash) -> ExternResult<Option<Record>> {
    get(workspace_hash, GetOptions::local())
}

#[hdk_extern]
pub fn get_workspaces_for_document(document_hash: ZomeFnInput<EntryHash>) -> ExternResult<Vec<Link>> {
    let strategy = document_hash.get_strategy();
    get_links(
        LinkQuery::try_new(
            document_hash.input,
            LinkTypes::DocumentToWorkspaces,
        )?, strategy
    )
}

#[derive(Serialize, Deserialize, Debug)]
pub struct UpdateWorkspaceTipInput {
    workspace_hash: EntryHash,
    new_tip_hash: ActionHash,
    previous_commit_hashes: Vec<ActionHash>,
}

#[hdk_extern]
pub fn update_workspace_tip(input: UpdateWorkspaceTipInput) -> ExternResult<()> {
    let tag = SerializedBytes::try_from(PreviousCommitsTag(input.previous_commit_hashes.clone()))
        .map_err(|err| wasm_error!(err))?;

    create_link_relaxed(
        input.workspace_hash.clone(),
        input.new_tip_hash.clone(),
        LinkTypes::WorkspaceToTip,
        tag.bytes().clone(),
    )?;

    // Retract the tip links this commit supersedes so the link set doesn't
    // grow without bound; get_workspace_tips keeps pruning by tag for links
    // whose deletes haven't propagated yet
    let existing = get_links(
        LinkQuery::try_new(input.workspace_hash, LinkTypes::WorkspaceToTip)?,
        GetStrategy::Local,
    )?;
    let superseded: HashSet<ActionHash> = input.previous_commit_hashes.into_iter().collect();
    for link in existing {
        if let Ok(target) = ActionHash::try_from(link.target.clone()) {
            if superseded.contains(&target) && target != input.new_tip_hash {
                delete_link_relaxed(link.create_link_hash)?;
            }
        }
    }

    Ok(())
}

#[hdk_extern]
pub fn get_workspace_tips(workspace_hash: ZomeFnInput<EntryHash>) -> ExternResult<Vec<Link>> {
    let strategy = workspace_hash.get_strategy();
    let links = get_links(
        LinkQuery::try_new(
            workspace_hash.input,
            LinkTypes::WorkspaceToTip,
        )?, strategy
    )?;

    let mut tips: HashMap<ActionHash, Link> = HashMap::new();
    let mut tips_previous = HashSet::new();
    for l in links {
        // Validation guarantees action-hash targets; skip anything else so
        // one odd link can't break tip resolution for everyone
        let Ok(target) = ActionHash::try_from(l.target.clone()) else {
            continue;
        };
        tips.insert(target, l.clone());

        // Validation guarantees the tag parses for links created under this
        // integrity zome; skip rather than fail on anything else so one odd
        // link can't break tip resolution for everyone
        let Ok(previous_commit_hashes) = PreviousCommitsTag::try_from(SerializedBytes::from(
            UnsafeBytes::from(l.tag.clone().into_inner()),
        )) else {
            continue;
        };

        for previous_commit_hash in previous_commit_hashes.0 {
            tips_previous.insert(previous_commit_hash);
        }
    }
    for p in tips_previous {
        tips.remove(&p);
    }
    Ok(tips.into_values().collect())
}

#[hdk_extern]
pub fn get_workspace_session_participants(workspace_hash: ZomeFnInput<EntryHash>) -> ExternResult<Vec<Link>> {
    let strategy = workspace_hash.get_strategy();
    get_links(
        LinkQuery::try_new(
            workspace_hash.input,
            LinkTypes::WorkspaceToParticipant,
        )?, strategy
    )
}

#[hdk_extern]
pub fn join_workspace_session(workspace_hash: EntryHash) -> ExternResult<Vec<AgentPubKey>> {
    let my_pub_key = agent_info()?.agent_initial_pubkey;
    let participants_links = get_workspace_session_participants(ZomeFnInput::new(workspace_hash.clone(), None ))?;

    let participants: Vec<AgentPubKey> = participants_links
        .into_iter()
        .filter_map(|l| AgentPubKey::try_from(l.target).ok())
        .unique()
        .collect();

    if !participants.contains(&my_pub_key) {
        create_link_relaxed(
            workspace_hash.clone(),
            my_pub_key,
            LinkTypes::WorkspaceToParticipant,
            (),
        )?;
        // Signal
        send_message(SendMessageInput {
            message: SessionMessage {
                workspace_hash: workspace_hash.clone(),
                payload: MessagePayload::JoinSession,
            },
            recipients: participants.clone(),
        })?;
    }

    Ok(participants)
}

#[hdk_extern]
pub fn leave_workspace_session(workspace_hash: EntryHash) -> ExternResult<()> {
    let my_pub_key = agent_info()?.agent_initial_pubkey;

    let links = get_links(
        LinkQuery::try_new(
            workspace_hash.clone(),
            LinkTypes::WorkspaceToParticipant,
        )?, GetStrategy::Local,
    )?;

    let my_links: Vec<Link> = links
        .clone()
        .into_iter()
        .filter(|l| {
            AgentPubKey::try_from(l.target.clone())
                .map(|agent| agent == my_pub_key)
                .unwrap_or(false)
        })
        //        .filter(|l| AgentPubKey::from(EntryHash::from(l.target.clone())).eq(&my_pub_key))
        .collect();

    let participants: Vec<AgentPubKey> = links
        .into_iter()
        .filter_map(|l: Link| AgentPubKey::try_from(l.target).ok())
        .filter(|agent_pub_key| !agent_pub_key.eq(&my_pub_key))
        .collect();

    for my_link in my_links {
        delete_link_relaxed(my_link.create_link_hash)?;
    }

    // Signal
    send_message(SendMessageInput {
        message: SessionMessage {
            workspace_hash: workspace_hash.clone(),
            payload: MessagePayload::LeaveSession,
        },
        recipients: participants.clone(),
    })?;

    Ok(())
}
