<script>
  import Title from './Title.svelte';
  import {
    SynStore,
    SynClient,
    DocumentStore,
    WorkspaceStore
  } from '@holochain-syn/core';
  import '@holochain-syn/core/dist/elements/syn-context.js'
  import '@holochain-syn/core/dist/elements/commit-history.js'
  import '@holochain-syn/core/dist/elements/session-participants.js'
  import '@holochain-syn/text-editor/dist/elements/syn-markdown-editor.js';
  import { createClient, DocumentGrammar, textSlice } from './syn';
  import {toPromise} from '@holochain-open-dev/stores'
  import { setContext, onMount } from 'svelte';
  import { get } from 'svelte/store';
  import {
    ProfilesClient,
    ProfilesStore,
  } from '@holochain-open-dev/profiles';
  import '@holochain-open-dev/profiles/dist/elements/profiles-context.js'
  import '@holochain-open-dev/profiles/dist/elements/profile-prompt.js'

  $: disconnected = false;
  let syn;

  // The debug drawer's ability to resized and hidden
  let resizeable;
  let resizeHandle;
  const minDrawerSize = 0;
  const maxDrawerSize = document.documentElement.clientHeight - 30 - 10;
  const initResizeable = resizeableEl => {
    resizeableEl.style.setProperty('--max-height', `${maxDrawerSize}px`);
    resizeableEl.style.setProperty('--min-height', `${minDrawerSize}px`);
  };

  const setDrawerHeight = height => {
    document.documentElement.style.setProperty(
      '--resizeable-height',
      `${height}px`
    );
  };
  const getDrawerHeight = () => {
    const pxHeight = getComputedStyle(resizeable).getPropertyValue(
      '--resizeable-height'
    );
    return parseInt(pxHeight, 10);
  };

  const startDragging = event => {
    event.preventDefault();
    const host = resizeable;
    const startingDrawerHeight = getDrawerHeight();
    const yOffset = event.pageY;

    const mouseDragHandler = moveEvent => {
      moveEvent.preventDefault();
      const primaryButtonPressed = moveEvent.buttons === 1;
      if (!primaryButtonPressed) {
        setDrawerHeight(
          Math.min(Math.max(getDrawerHeight(), minDrawerSize), maxDrawerSize)
        );
        window.removeEventListener('pointermove', mouseDragHandler);
        return;
      }
      setDrawerHeight(
        Math.min(
          Math.max(
            yOffset - moveEvent.pageY + startingDrawerHeight,
            minDrawerSize
          ),
          maxDrawerSize
        )
      );
    };
    const remove = window.addEventListener('pointermove', mouseDragHandler);
  };

  let drawerHidden = false;
  const hideDrawer = () => {
    drawerHidden = true;
  };
  const showDrawer = () => {
    drawerHidden = false;
  };

  let tabShown = false;
  const showTab = () => {
    tabShown = true;
  };
  const hideTab = () => {
    tabShown = false;
  };

  let profilesStore;
  let synStore;
  let documentStore;
  let workspaceStore;
  let sessionStore;
  let sessionStatus;

  let config = {
    heartbeatInterval: 5 * 1000,
    newPeersDiscoveryInterval: 30 * 1000,
    outOfSessionTimeout: 60 * 1000,
    commitStrategy: { CommitEveryNDeltas: 200, CommitEveryNMs: 1000 * 30 },
  };

  async function initSyn(client) {
    const store = new SynStore(new SynClient(client, 'syn-test'));
    const documentsHashes = Array.from((await toPromise(store.documentsByTag.get("active"))).keys());

    if (documentsHashes.length === 0) {
      documentStore = await store.createDocument(DocumentGrammar.initialState());

      await store.client.tagDocument(documentStore.documentHash, 'active')

      workspaceStore = await documentStore.createWorkspace(
        'main'
      );
      sessionStore = await workspaceStore.joinSession(config);
      synStore = store;
    } else {
      documentStore = store.documents.get(documentsHashes[0]);
      const workspaces = await toPromise(documentStore.allWorkspaces);

      workspaceStore = Array.from(workspaces.values())[0];
      sessionStore = await workspaceStore.joinSession(config);
      sessionStatus = sessionStore.sessionStatus
      synStore = store;
    }
  }
  onMount(async () => {
    let client = await createClient();
    profilesStore = new ProfilesStore(new ProfilesClient(client, 'syn-test'));
    await initSyn(client);
  });

  $: synStore, workspaceStore, profilesStore, sessionStore;

  let autoType = false

  setContext('sessionStore', {
    getSessionStore: () => sessionStore,
  });
</script>

<svelte:head>
  <script
    src="https://kit.fontawesome.com/80d72fa568.js"
    crossorigin="anonymous"></script>
</svelte:head>

{#if synStore}
  <profiles-context store={profilesStore}>
    <syn-context synstore={synStore}>
      <div class="toolbar">
        <h1>SynText</h1>
        {$sessionStatus?.code} -
        {$sessionStatus?.lastSave} -
        {$sessionStatus?.error}
        <!-- <div>
          <Title />
        </div> -->
        <!-- leave session -->
        <button on:click={async ()=>{
          await sessionStore.leaveSession()
        }}>Leave Session</button>
        <!-- join session -->
        <button on:click={async ()=>{
          sessionStore = await workspaceStore.joinSession()
        }}>Join Session</button>
        <!-- force commit -->
        <button on:click={async ()=>{
          await sessionStore.commitChanges()
        }}>Force Commit</button>
        <!-- <div on:click={()=>autoType = !autoType}>autoType: {autoType}</div> -->
      </div>
      <main style="display: flex; height: 400px">
  <profile-prompt>
      <div style="display: flex; flex-direction:row; flex: 1;">
        <syn-markdown-editor autotype={autoType} style="flex: 1;" slice={textSlice(sessionStore)}></syn-markdown-editor>
        <commit-history documentstore={documentStore}></commit-history>
      </div>
    </profile-prompt>
      </main>

      <div class="folks-tray">
        <h3>Participants</h3>
        <session-participants direction="row" showOffline={true} sessionstore={sessionStore} />
      </div>
    </syn-context>
  </profiles-context>
{/if}

<style>
  main {
    padding: 1em;
    background: hsla(100, 20%, 50%, 0.2);
    grid-column: 1 / 1;
    grid-row: 2 / 2;
  }
  syn-markdown-editor {
    height: 100%;
    width: 100%;
  }
  .toolbar {
    background: hsla(19, 20%, 50%, 0.2);
    padding: 2rem;
    grid-column: 1 / 1;
    grid-row: 1 / 1;
  }

  .folks-tray {
    min-width: calc((var(--folks-padding) * 2) + var(--folk-hex-width));
    width: auto;
    background: hsla(255, 20%, 50%, 0.2);
    grid-column: 2 / 2;
    grid-row: 1 / 3;
  }

  :global(:root) {
    --resizeable-height: 200px;
    --tab-width: 60px;
  }

  .debug-drawer {
    width: 100%;
    box-sizing: border-box;
    height: var(--resizeable-height);
    min-height: var(--min-height);
    max-height: var(--max-height);
    background: hsla(180, 30%, 85%, 1);
    position: absolute;
    bottom: 0;
    text-align: left;
    grid-column: 1 / 2;
    overflow: hidden;
    z-index: 90;
  }

  .hidden {
    height: 0;
    min-height: 0;
  }

  .handle {
    height: 1px;
    width: 100%;
    background-color: hsla(180, 15%, 65%, 1);
    z-index: 100;
  }

  .handle::after {
    content: '';
    height: 9px;
    position: absolute;
    left: 0;
    right: 0;
    margin-bottom: -4px;
    background-color: transparent;
    cursor: ns-resize;
    z-index: 101;
  }

  /* tab styling reverse-engineered from Atom */
  .tab {
    z-index: 130;
    position: absolute;
    width: var(--tab-width);
    height: calc(var(--tab-width) / 2);
    left: calc(50% - (var(--tab-width) / 2));
    bottom: var(--resizeable-height);
    overflow: hidden;
    margin-bottom: -2px;
    border-top-left-radius: calc(var(--tab-width) / 2);
    border-top-right-radius: calc(var(--tab-width) / 2);

    pointer-events: none;
  }

  .tab-inner {
    position: absolute;
    box-sizing: border-box; /* borders included in size */
    width: var(--tab-width);
    height: var(--tab-width);
    background: hsla(180, 30%, 85%);
    border: 1px solid hsla(180, 20%, 65%, 1);
    color: hsla(180, 20%, 50%, 1); /* color of chevron */
    border-radius: calc(var(--tab-width) / 2);
    cursor: pointer;
    text-align: center;

    top: calc(var(--tab-width) / 2);
    transition: transform 0.2s ease-out 0.2s;
  }

  .tab.shown {
    pointer-events: all;
  }

  .tab-inner.shown {
    transform: translateY(-50%);
    transition: transform 0.2s ease-out 0s;
  }

  /* allow the tab to pop up when drawer is hidden */
  .tab.drawer-hidden {
    bottom: 0;
    pointer-events: all;
  }

  .tab-icon {
    margin-top: 9px;
  }

  .debug-content {
    padding: 1rem;
    word-wrap: break-word;
    height: 100%;
    overflow-y: scroll;
    box-sizing: border-box;
    z-index: 90;
  }

  body {
    font-family: system-ui, sans-serif;
  }

  h1 {
    color: #ff3e00;
    text-transform: uppercase;
    font-size: 4em;
    font-weight: 100;
    margin: auto;
  }

  @media (min-width: 640px) {
    main {
      max-width: none;
    }
  }
</style>
