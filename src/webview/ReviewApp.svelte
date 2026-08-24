<script lang="ts">
  import { onMount } from 'svelte';
  import { bridge } from './lib/message-bridge';

  let ready = false;
  let error = '';

  onMount(async () => {
    try {
      await bridge.send('review.list');
      ready = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
  });
</script>

<div class="review-app">
  <header class="toolbar" aria-label="Review toolbar">Code Review</header>
  {#if error}<div class="error" role="alert">{error}</div>{/if}
  {#if ready}<p>ready</p>{/if}
</div>

<style>
  .review-app { height: 100%; display: flex; flex-direction: column; }
</style>
