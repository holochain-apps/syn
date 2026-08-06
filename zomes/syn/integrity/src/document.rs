use hdi::prelude::*;

#[hdk_entry_helper]
#[derive(Clone)]
pub struct Document {
    pub initial_state: SerializedBytes,
    pub meta: Option<SerializedBytes>,
    /// Distinguishes otherwise-identical documents so every ordinary
    /// create_document yields a distinct entry hash; absent for
    /// deterministic documents, which must converge on the same entry hash
    /// no matter which agent creates them.
    pub nonce: Option<SerializedBytes>,
}
