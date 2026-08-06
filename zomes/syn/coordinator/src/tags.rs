use hc_zome_syn_integrity::*;
use hdk::prelude::*;

use crate::utils::{create_link_relaxed, ZomeFnInput};

fn tag_path(tag: String) -> Path {
    Path::from(format!("document_tags.{}", tag))
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TagDocumentInput {
    document_hash: EntryHash,
    tag: String,
}

#[hdk_extern]
pub fn tag_document(input: TagDocumentInput) -> ExternResult<()> {
    let path = tag_path(input.tag);

    let _ = create_link_relaxed(
        path.path_entry_hash()?,
        input.document_hash.clone(),
        LinkTypes::TagToDocument,
        (),
    )?;

    Ok(())
}

#[hdk_extern]
pub fn tag_path_entry_hash(tag: String) -> ExternResult<EntryHash> {
    tag_path(tag).path_entry_hash()
}

#[hdk_extern]
pub fn get_documents_with_tag(tag: ZomeFnInput<String>) -> ExternResult<Vec<Link>> {
    let strategy = tag.get_strategy();
    get_links(
        LinkQuery::try_new(
            tag_path(tag.input).path_entry_hash()?,
            LinkTypes::TagToDocument,
        )?, strategy
    )
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RemoveDocumentTagInput {
    document_hash: EntryHash,
    tag: String,
}

#[hdk_extern]
pub fn remove_document_tag(input: RemoveDocumentTagInput) -> ExternResult<()> {
    let links = get_links(
        LinkQuery::try_new(
            tag_path(input.tag).path_entry_hash()?,
            LinkTypes::TagToDocument,
        )?, GetStrategy::Local
    )?;

    for link in links {
        if let Some(target) = link.target.into_entry_hash() {
            if target.eq(&input.document_hash) {
                delete_link(link.create_link_hash, GetOptions::local())?;
            }
        }
    }

    Ok(())
}
