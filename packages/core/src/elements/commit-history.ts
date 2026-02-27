import { css, html, LitElement } from 'lit';
import '@scoped-elements/cytoscape';
import { customElement, property } from 'lit/decorators.js';
import { consume } from '@lit/context';
import type { NodeDefinition, EdgeDefinition } from 'cytoscape';

import {
  encodeHashToBase64,
  decodeHashFromBase64,
  ActionHashB64,
  Record as HcRecord,
} from '@holochain/client';
import { RecordBag } from '@holochain-open-dev/utils';

import '@shoelace-style/shoelace/dist/components/card/card.js';
import '@shoelace-style/shoelace/dist/components/spinner/spinner.js';
import '@holochain-open-dev/elements/dist/elements/display-error.js';

import { Commit } from '@holochain-syn/client';
import { DocumentStore } from '@holochain-syn/store';
import { joinAsync, pipe, StoreSubscriber } from '@holochain-open-dev/stores';
import { sharedStyles } from '@holochain-open-dev/elements';
import { localized, msg } from '@lit/localize';

import { synDocumentContext } from '../contexts.js';

@localized()
@customElement('commit-history')
export class CommitHistory extends LitElement {
  @consume({ context: synDocumentContext, subscribe: true })
  @property()
  documentstore!: DocumentStore<any, any>;

  @property()
  selectedCommitHash: ActionHashB64 | undefined;

  private _allCommits = new StoreSubscriber(
    this,
    () =>
      pipe(this.documentstore.allCommits, c =>
        joinAsync(Array.from(c.values()))
      ),
    () => []
  );

  onNodeSelected(nodeId: string) {
    this.selectedCommitHash = nodeId;
    this.dispatchEvent(
      new CustomEvent('commit-selected', {
        bubbles: true,
        composed: true,
        detail: {
          commitHash: decodeHashFromBase64(nodeId),
        },
      })
    );
  }

  get selectedNodeIds() {
    return this.selectedCommitHash ? [this.selectedCommitHash] : [];
  }

  renderContent(allCommits: RecordBag<Commit>) {
    const elements = getCommitGraph(allCommits);
    if (elements.length === 0)
      return html` <div
        class="row"
        style="flex: 1; align-items: center; justify-content: center;"
      >
        <span class="placeholder"> There are no commits yet </span>
      </div>`;

    return html`<cytoscape-dagre
      style="flex: 1;"
      .fixed=${true}
      .options=${{
        style: `
          edge {
            target-arrow-shape: triangle;
            width: 2px;
          }
        `,
      }}
      .selectedNodesIds=${this.selectedNodeIds}
      .elements=${elements}
      .dagreOptions=${{
        rankDir: 'BT',
      }}
      @node-selected=${(e: CustomEvent) => this.onNodeSelected(e.detail.id())}
    ></cytoscape-dagre>`;
  }

  render() {
    switch (this._allCommits.value.status) {
      case 'pending':
        return html`
          <div
            class="row"
            style="flex: 1; align-items: center; justify-content: center;"
          >
            <sl-spinner style="font-size: 2rem"></sl-spinner>
          </div>
        `;
      case 'complete':
        return html`<sl-card style="flex: 1;">
          <span slot="header" class="title">${msg('Commit History')}</span>
          ${this.renderContent(
          new RecordBag((this._allCommits.value.value as Array<{ record: HcRecord }>).map(er => er.record))
        )}
        </sl-card>`;
      case 'error':
        return html`<display-error
          .headline=${msg('Error fetching the commit history')}
          .error=${this._allCommits.value.error}
        ></display-error>`;
    }
  }

  static styles = [
    sharedStyles,
    css`
      :host {
        display: flex;
      }
      sl-card::part(body) {
        padding: 0;
      }
    `,
  ];
}

function getCommitGraph(
  commits: RecordBag<Commit>
): Array<NodeDefinition | EdgeDefinition> {
  const elements: Array<NodeDefinition | EdgeDefinition> = [];

  for (const commitHash of commits.actionMap.keys()) {
    const strCommitHash = encodeHashToBase64(commitHash);
    elements.push({
      data: {
        id: strCommitHash,
      },
    });

    for (const parentCommitHash of commits.entryRecord(commitHash)?.entry
      .previous_commit_hashes || []) {
      const strParentCommitHash = encodeHashToBase64(parentCommitHash);

      elements.push({
        data: {
          id: `${strParentCommitHash}->${strCommitHash}`,
          source: strParentCommitHash,
          target: strCommitHash,
        },
      });
    }
  }

  return elements;
}
