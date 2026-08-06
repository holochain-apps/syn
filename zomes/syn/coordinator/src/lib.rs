use commit::LinkDocumentToCommitInput;
use hc_zome_syn_integrity::*;
use hdk::prelude::*;
use messages::SessionMessage;

mod commit;
mod document;
mod messages;
mod tags;
mod utils;
mod workspace;

#[hdk_extern]
pub fn init(_: ()) -> ExternResult<InitCallbackResult> {
    let mut fns = HashSet::new();
    fns.insert((zome_info()?.name, FunctionName("recv_remote_signal".into())));
    let cap_grant_entry: CapGrantEntry = CapGrantEntry::new(
        String::from("remote signals"), // A string by which to later query for saved grants.
        ().into(), // Unrestricted access means any external agent can call the extern
        GrantedFunctions::Listed(fns),
    );
    create_cap_grant(cap_grant_entry)?;

    Ok(InitCallbackResult::Pass)
}

#[hdk_extern]
pub fn recv_remote_signal(message: SessionMessage) -> ExternResult<()> {
    let info = call_info()?;

    let notice = Signal::SessionMessage {
        message,
        provenance: info.provenance,
    };

    emit_signal(notice)
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(tag = "type")]
pub enum Signal {
    SessionMessage {
        provenance: AgentPubKey,
        message: SessionMessage,
    },
    LinkCreated {
        action: SignedActionHashed,
        link_type: LinkTypes,
    },
    LinkDeleted {
        action: SignedActionHashed,
        create_link_action: SignedActionHashed,
        link_type: LinkTypes,
    },
    EntryCreated {
        action: SignedActionHashed,
        app_entry: EntryTypes,
    },
    EntryUpdated {
        action: SignedActionHashed,
        app_entry: EntryTypes,
        original_app_entry: EntryTypes,
    },
    EntryDeleted {
        action: SignedActionHashed,
        original_app_entry: EntryTypes,
    },
}
#[hdk_extern(infallible)]
pub fn post_commit(committed_actions: Vec<SignedActionHashed>) {
    for action in committed_actions {
        if let Err(err) = signal_action(action) {
            error!("Error signaling new action: {:?}", err);
        }
    }
}
fn signal_action(action: SignedActionHashed) -> ExternResult<()> {
    match action.hashed.content.data.clone() {
        ActionData::CreateLink(create_link) => {
            if let Ok(Some(link_type)) =
                LinkTypes::from_type(create_link.zome_index, create_link.link_type)
            {
                emit_signal(Signal::LinkCreated { action, link_type })?;
            }
            Ok(())
        }
        ActionData::DeleteLink(delete_link) => {
            let record = get(delete_link.link_add_address.clone(), GetOptions::local())?.ok_or(
                wasm_error!(WasmErrorInner::Guest(
                    "Failed to fetch CreateLink action".to_string()
                )),
            )?;
            match &record.action().data {
                ActionData::CreateLink(create_link) => {
                    if let Ok(Some(link_type)) = LinkTypes::from_type(
                        create_link.zome_index,
                        create_link.link_type,
                    ) {
                        emit_signal(Signal::LinkDeleted {
                            action,
                            link_type,
                            create_link_action: record.signed_action.clone(),
                        })?;
                    }
                    Ok(())
                }
                _ => {
                    return Err(wasm_error!(WasmErrorInner::Guest(
                        "Create Link should exist".to_string()
                    )));
                }
            }
        }
        ActionData::Create(_create) => {
            if let Ok(Some(app_entry)) = get_entry_for_action(&action.hashed.hash) {
                if let EntryTypes::Commit(commit) = &app_entry {
                    let response = call_remote(
                        agent_info()?.agent_initial_pubkey,
                        zome_info()?.name,
                        FunctionName::from("link_document_to_commit"),
                        None,
                        LinkDocumentToCommitInput {
                            document_hash: commit.document_hash.clone(),
                            commit_hash: action.hashed.hash.clone(),
                        },
                    )?;

                    match response {
                        ZomeCallResponse::Ok(_) => {}
                        _ => error!("Error linking document to commit: {response:?}"),
                    }
                }
                emit_signal(Signal::EntryCreated { action, app_entry })?;
            }
            Ok(())
        }
        ActionData::Update(update) => {
            if let Ok(Some(app_entry)) = get_entry_for_action(&action.hashed.hash) {
                if let Ok(Some(original_app_entry)) =
                    get_entry_for_action(&update.original_action_address)
                {
                    emit_signal(Signal::EntryUpdated {
                        action,
                        app_entry,
                        original_app_entry,
                    })?;
                }
            }
            Ok(())
        }
        ActionData::Delete(delete) => {
            if let Ok(Some(original_app_entry)) = get_entry_for_action(&delete.deletes_address) {
                emit_signal(Signal::EntryDeleted {
                    action,
                    original_app_entry,
                })?;
            }
            Ok(())
        }
        _ => Ok(()),
    }
}
fn get_entry_for_action(action_hash: &ActionHash) -> ExternResult<Option<EntryTypes>> {
    let record = match get_details(action_hash.clone(), GetOptions::local())? {
        Some(Details::Record(record_details)) => record_details.record,
        _ => {
            return Ok(None);
        }
    };
    let entry = match record.entry().as_option() {
        Some(entry) => entry,
        None => {
            return Ok(None);
        }
    };
    let (zome_index, entry_index) = match record.action().entry_type() {
        Some(EntryType::App(AppEntryDef {
            zome_index,
            entry_index,
            ..
        })) => (zome_index, entry_index),
        _ => {
            return Ok(None);
        }
    };
    Ok(EntryTypes::deserialize_from_type(
        zome_index.clone(),
        entry_index.clone(),
        entry,
    )?)
}
