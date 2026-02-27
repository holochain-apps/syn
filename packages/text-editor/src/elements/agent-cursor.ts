import { css, html, LitElement } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styleMap } from 'lit/directives/style-map.js';
import { AgentPubKey, encodeHashToBase64 } from '@holochain/client';

import '@shoelace-style/shoelace/dist/components/tooltip/tooltip.js';
import { hashProperty } from '@holochain-open-dev/elements';
import { consume } from '@lit/context';
import {
  ProfilesStore,
  profilesStoreContext,
} from '@holochain-open-dev/profiles';
import { StoreSubscriber } from '@holochain-open-dev/stores';
import { msg } from '@lit/localize';
import { getFolkColors } from '@holochain-syn/core';

@customElement('agent-cursor')
export class AgentCursor extends LitElement {
  @property(hashProperty('agent'))
  agent!: AgentPubKey;

  @consume({ context: profilesStoreContext, subscribe: true })
  profilesStore!: ProfilesStore;

  private _profile = new StoreSubscriber(
    this,
    () => this.profilesStore.profiles.get(this.agent)!,
    () => [this.agent]
  );

  renderCursor() {
    return html`<div
      class="cursor"
      style=${styleMap({
        'background-color': this.color,
      })}
    ></div>`;
  }

  get color() {
    const { r, g, b } = getFolkColors(encodeHashToBase64(this.agent));
    return `rgb(${r},${g},${b})`;
  }

  get name() {
    if (this._profile.value.status === 'pending') return msg('Loading...');
    if (this._profile.value.status === 'error') return msg('Error');

    if (!this._profile.value.value) return msg('Unknown');
    return this._profile.value.value.entry.nickname;
  }

  render() {
    return html`
      <sl-tooltip
        style=${styleMap({ '--sl-tooltip-background-color': this.color })}
        .open=${true}
        trigger="manual"
        placement="top"
        .content=${this.name}
      >
        ${this.renderCursor()}
      </sl-tooltip>
    `;
  }

  static styles = css`
    .cursor {
      width: 1px;
      height: 18px;
      margin-left: -1;
    }
  `;
}
