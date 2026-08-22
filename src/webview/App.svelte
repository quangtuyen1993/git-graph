<script lang="ts">
  import { bridge } from './lib/message-bridge';
  import { onMount } from 'svelte';

  let status = 'Connecting...';

  onMount(async () => {
    try {
      const result = await bridge.send('ping.hello') as { pong: boolean; timestamp: number };
      if (result.pong) {
        status = 'Git Graph Pro — Connected ✓';
      }
    } catch (e) {
      status = `Git Graph Pro — Error: ${e}`;
    }
  });
</script>

<div class="container">
  <header class="toolbar">
    <h1>{status}</h1>
  </header>
  <main class="graph-area">
    <p class="placeholder">Graph will render here</p>
  </main>
</div>

<style>
  .container {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .toolbar {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
  }

  .toolbar h1 {
    font-size: 14px;
    font-weight: 600;
  }

  .graph-area {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .placeholder {
    opacity: 0.5;
    font-size: 16px;
  }
</style>
