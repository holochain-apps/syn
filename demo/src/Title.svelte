<script>
  import { createEventDispatcher, tick, getContext } from 'svelte'

  const dispatch = createEventDispatcher()

  let titleBeingTyped = ''

  const { getSessionStore } = getContext('sessionStore');

  const sessionStore = getSessionStore();
  // docState (read-only live doc view): reading a single field must not pay
  // the state getter's whole-document materialization per keystroke
  $: state = sessionStore.docState;

  let editingTitle = false
  function saveTitle() {
    if (editingTitle) {
      // only dispatch a changeReq if the title trying to be saved is different
      // than the current title
      if (titleBeingTyped !== $state.title) {
        let delta = { type: 'SetTitle', value: titleBeingTyped }
        workpsaceStore.requestChanges([delta])
      }
      titleBeingTyped = ''
      editingTitle = false
    } else {
      console.log("Can't run saveTitle when it wasn't being edited!")
    }
  }

  let titleEl // variable to bind the title input to when it's created
  async function beginEditTitle() {
    titleHover=false
    titleBeingTyped = $state.title // fill the field with the current title
    editingTitle = true
    await tick() // wait for the title input element to be created
    titleEl.focus()
  }

  function handleTitleKeypress() {
		if (event.key == 'Enter') {
      saveTitle()
    } else if (event.key == 'Escape') {
      // don't save new title & discard changes
      titleBeingTyped = ''
      // turn off editing
      editingTitle=false
    }
  }

  // keep track of whether the doc is untitled
  let untitled
  $: untitled = ($state.title === '')

  let titleHover // whether the title is being hovered


</script>
<style>
  .title-wrapper {
    height: 1.6em;
  }

  .title {
    /* min-width: 10em;
    min-height: 1em; */
    font-weight: bold;
    display: inline-block;
    padding: 0.4em;
    -webkit-padding: 0.4em 0;
    margin: 0 0 0.5em 0;
    border-width: 1px;
    border-color: #00000000;
    border-style: solid;
    border-radius: 2px;
  }

  .title-hover {
    border-style: dashed;
    border-color: #aaa;
  }

  /* input has to be below hover so it overrides */
  .title-input {
  border-style: solid;
  border-color: #ccc;
  font-weight: bold;
  margin-bottom: 0;
  }

  .untitled {
    color: lightgray;
  }
</style>

<div class='title-wrapper'>
  Title:
  {#if editingTitle}
    <input class='title-input' bind:value={titleBeingTyped} on:keydown={handleTitleKeypress} on:blur={saveTitle} bind:this={titleEl}/>
  {:else}
    <div class='title' class:title-hover={titleHover} on:mouseenter={()=>{titleHover=true}} on:mouseleave={()=>{titleHover=false}} on:click={beginEditTitle}>
      <span class:untitled>
        {#if untitled}
          Untitled Document
        {:else}
          {$state.title}
        {/if}
      </span>
    </div>
  {/if}
</div>
