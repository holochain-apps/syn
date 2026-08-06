use hc_zome_syn_integrity::*;
use hdk::prelude::*;

use crate::utils::ZomeFnInput;

#[hdk_extern]
pub fn create_document(document: Document) -> ExternResult<Record> {
    let action_hash = create_entry(EntryTypes::Document(document.clone()))?;
    // The entry hash is the document's canonical identity: every link to or
    // from a document uses it, so concurrent creators of the same
    // (deterministic) document converge on the same link bases
    let document_hash = hash_entry(&document)?;
    create_link(
        document_hash,
        agent_info()?.agent_initial_pubkey,
        LinkTypes::DocumentToAuthors,
        (),
    )?;

    let maybe_record = get(action_hash, GetOptions::local())?;
    let record = maybe_record.ok_or(wasm_error!(WasmErrorInner::Guest(String::from(
        "Could not get the record created just now"
    ))))?;

    Ok(record)
}

#[hdk_extern]
pub fn get_document(document_hash: EntryHash) -> ExternResult<Option<Record>> {
    get(document_hash, GetOptions::local())
}

#[hdk_extern]
pub fn get_authors_for_document(document_hash: ZomeFnInput<EntryHash>) -> ExternResult<Vec<Link>> {
    let strategy = document_hash.get_strategy();
    get_links(
        LinkQuery::try_new(
            document_hash.input,
            LinkTypes::DocumentToAuthors,
        )?, strategy
    )
}
