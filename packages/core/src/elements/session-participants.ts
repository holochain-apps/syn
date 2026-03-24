import { css, html, LitElement } from 'lit';
import type { SessionStore } from '@holochain-syn/store';
import { customElement, property } from 'lit/decorators.js';
import { consume } from '@lit/context';
import { AgentPubKey, encodeHashToBase64 } from '@holochain/client';
import { classMap } from 'lit/directives/class-map.js';
import { styleMap } from 'lit/directives/style-map.js';
import { StoreSubscriber } from '@holochain-open-dev/stores';

import { sharedStyles } from '@holochain-open-dev/elements';
import '@holochain-open-dev/profiles/dist/elements/agent-avatar.js';

import { synSessionContext } from '../contexts.js';

@customElement('session-participants')
export class SessionParticipants extends LitElement {
  @consume({ context: synSessionContext, subscribe: true })
  @property()
  sessionstore!: SessionStore<any, any>;

  @property()
  direction: 'column' | 'row' = 'column';

  @property({ type: Boolean })
  showOffline = false;

  _participants = new StoreSubscriber(
    this,
    () => this.sessionstore.participants,
    () => [this.sessionstore]
  );

  renderParticipant(pubKey: AgentPubKey, status: string) {
    const classes = {
      'status-dot': true,
      active: status === 'active',
      idle: status === 'idle',
      offline: status === 'offline',
    };
    return html`
      <div
        class="participant"
        style=${styleMap({
          'margin-bottom': this.direction === 'column' ? '8px' : '0px',
          'margin-right': this.direction === 'row' ? '-4px' : '0px',
        })}
      >
        <agent-avatar
          .agentPubKey=${pubKey}
        ></agent-avatar>
        <span class=${classMap(classes)}></span>
        </div>
    `;
  }

  render() {
    return html`
      <div
        class=${classMap({
          column: this.direction === 'column',
          row: this.direction === 'row',
        })}
      >
        ${[
          ...this._participants.value.active.map(pubKey => ({ pubKey, status: 'active' })),
          ...this._participants.value.idle.map(pubKey => ({ pubKey, status: 'idle' })),
        ]
          .sort((a, b) => {
            const ka = encodeHashToBase64(a.pubKey);
            const kb = encodeHashToBase64(b.pubKey);
            return ka < kb ? -1 : ka > kb ? 1 : 0;
          })
          .map(({ pubKey, status }) => this.renderParticipant(pubKey, status))
        }
        ${this.showOffline
          ? this._participants.value.offline.map(pubKey =>
              this.renderParticipant(pubKey, 'offline')
            )
          : ''}
      </div>
    `;
  }

  static get styles() {
    return [
      sharedStyles,
      css`
        .participant {
          display: flex;
          flex-direction: row;
          align-items: center;
          position: relative;
        }
        .out-of-session {
          opacity: 0.5;
        }
        .status-dot {
          position: relative;
          bottom: -10px;
          right: 10px;
          width: 12px;
          height: 12px;
          border-radius: 50%;
          border: 2px solid white;
        }
        .status-dot.active {
          background-color: #00e676;
        }
        .status-dot.idle {
          background-color: #ffa726;
        }
        .status-dot.offline {
          background-color: transparent;
          border-color: #999;
        }
      `,
    ];
  }
}
