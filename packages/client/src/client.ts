import {
  AgentPubKey,
  EntryHash,
  Record,
  AppClient,
  AnyDhtHash,
  Link,
  ActionHash,
  encodeHashToBase64,
} from '@holochain/client';
import { EntryRecord, ZomeClient } from '@holochain-open-dev/utils';

import {
  Document,
  Commit,
  SendMessageInput,
  SessionMessage,
  SynSignal,
  Workspace,
} from './types.js';

export class SynClient extends ZomeClient<SynSignal> {
  constructor(
    public client: AppClient,
    public roleName: string,
    public zomeName = 'syn'
  ) {
    super(client, roleName, zomeName);
  }

  /** Documents */

  public async createDocument(
    document: Document
  ): Promise<EntryRecord<Document>> {
    const record: Record = await this.callZome('create_document', document);
    return new EntryRecord(record);
  }

  public async getDocumentsWithTag(tag: string, local?: boolean): Promise<Array<Link>> {
    return this.callZome('get_documents_with_tag', {input: tag, local});
  }

  public async getDocument(
    documentHash: AnyDhtHash
  ): Promise<EntryRecord<Document> | undefined> {
    const record: Record | undefined = await this.callZome(
      'get_document',
      documentHash
    );
    if (!record) return undefined;

    return new EntryRecord(record);
  }


  public async getAuthorsForDocument(documentHash: AnyDhtHash, local?: boolean): Promise<Array<Link>> {
    return this.callZome('get_authors_for_document', {input: documentHash, local});
  }

  public async tagDocument(
    documentHash: AnyDhtHash,
    tag: string
  ): Promise<void> {
    return this.callZome('tag_document', {
      document_hash: documentHash,
      tag,
    });
  }

  public async removeDocumentTag(
    documentHash: AnyDhtHash,
    tag: string
  ): Promise<void> {
    return this.callZome('remove_document_tag', {
      document_hash: documentHash,
      tag,
    });
  }

  public async tagPathEntryHash(tag: string): Promise<EntryHash> {
    return this.callZome('tag_path_entry_hash', tag);
  }

  /** Commits */
  public async createCommit(commit: Commit): Promise<EntryRecord<Commit>> {
    return new Promise((resolve, reject) => {
      let timeoutId: NodeJS.Timeout;
      let unsubs: (() => void) | undefined;

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId);
        if (unsubs) unsubs();
      };

      const rejectWithCleanup = (error: any) => {
        cleanup();
        reject(error);
      };

      const resolveWithCleanup = (result: EntryRecord<Commit>) => {
        cleanup();
        resolve(result);
      };

      unsubs = this.onSignal(signal => {
        // TODO: better check?
        if (
          signal.type === 'EntryCreated' &&
          signal.app_entry.type === 'Commit' &&
          encodeHashToBase64(commit.document_hash) ===
          encodeHashToBase64(signal.app_entry.document_hash)
        ) {
          this.getCommit(signal.action.hashed.hash)
            .then(r => {
              if (r) {
                // check that the previous commit hashes are equal
                const commitPreviousHashes = commit.previous_commit_hashes || [];
                const signalPreviousHashes = r.entry.previous_commit_hashes || [];
                if (commitPreviousHashes.length === signalPreviousHashes.length &&
                  commitPreviousHashes.every((val, index) => encodeHashToBase64(val) === encodeHashToBase64(signalPreviousHashes[index]))
                ) {
                  resolveWithCleanup(r);
                }
              } else {
                rejectWithCleanup(new Error('Commit not found after creation'));
              }
            })
            .catch(e => rejectWithCleanup(e))
        }
      });

      this.callZome('create_commit', commit).catch(e => rejectWithCleanup(e));
      timeoutId = setTimeout(() => rejectWithCleanup(new Error('Commit creation timed out after 30 seconds')), 30000);
    });
  }

  public async getCommit(
    commitHash: ActionHash
  ): Promise<EntryRecord<Commit> | undefined> {
    const record: Record | undefined = await this.callZome(
      'get_commit',
      commitHash
    );
    if (!record) return undefined;

    return new EntryRecord(record);
  }

  public async getCommitsForDocument(
    documentHash: AnyDhtHash,
    local?: boolean,
  ): Promise<Array<Link>> {
    const commits: Array<Link> = await this.callZome('get_commits_for_document', {input: documentHash, local});

    if (commits.length > 600) {
      console.warn(
        `Syn: document has ${commits.length} commits. This is unexpectedly high and may indicate a commit storm; please report it to the syn maintainers.`
      );
    }

    return commits;
  }

  /** Workspaces */
  public async createWorkspace(
    workspace: Workspace,
    initial_commit_hash: ActionHash | undefined
  ): Promise<EntryRecord<Workspace>> {
    const record: Record = await this.callZome('create_workspace', {
      workspace,
      initial_commit_hash,
    });
    return new EntryRecord(record);
  }

  public async getWorkspace(
    workspace_hash: EntryHash
  ): Promise<EntryRecord<Workspace> | undefined> {
    const workspace: Record | undefined = await this.callZome(
      'get_workspace',
      workspace_hash
    );
    return workspace ? new EntryRecord(workspace) : undefined;
  }

  public async getWorkspacesForDocument(
    documentHash: AnyDhtHash,
    local?: boolean,
  ): Promise<Array<Link>> {
    return this.callZome('get_workspaces_for_document', {input: documentHash, local});
  }

  public async getWorkspaceTips(
    workspaceHash: EntryHash,
    local?: boolean,
  ): Promise<Array<Link>> {
    return this.callZome('get_workspace_tips', {input: workspaceHash, local});
  }

  public updateWorkspaceTip(
    workspace_hash: EntryHash,
    new_tip_hash: ActionHash,
    previous_commit_hashes: Array<ActionHash>
  ): Promise<void> {
    return this.callZome('update_workspace_tip', {
      workspace_hash,
      new_tip_hash,
      previous_commit_hashes,
    });
  }

  public getWorkspaceSessionParticipants(
    workspace_hash: EntryHash,
    local?: boolean,
  ): Promise<Array<Link>> {
    return this.callZome('get_workspace_session_participants', {input: workspace_hash, local});
  }

  public async joinWorkspaceSession(
    workspace_hash: EntryHash
  ): Promise<AgentPubKey[]> {
    return this.callZome('join_workspace_session', workspace_hash);
  }

  public async leaveWorkspaceSession(workspace_hash: EntryHash): Promise<void> {
    return this.callZome('leave_workspace_session', workspace_hash);
  }

  public sendMessage(
    recipients: Array<AgentPubKey>,
    message: SessionMessage
  ): Promise<void> {
    return this.callZome('send_message', {
      recipients,
      message,
    } as SendMessageInput);
  }
}