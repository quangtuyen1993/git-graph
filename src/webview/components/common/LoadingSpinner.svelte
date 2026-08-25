<script lang="ts">
  export let size: 'sm' | 'md' = 'sm';
  export let label = 'Working…';
</script>

<span class="spinner spinner-{size}" role="status" aria-label={label}>
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor"
            stroke-width="2" stroke-dasharray="47 16" stroke-linecap="round" />
  </svg>
</span>

<style>
  .spinner {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--vscode-progressBar-background, #0e70c0);
    flex-shrink: 0;
  }

  .spinner-sm svg { width: 12px; height: 12px; }
  .spinner-md svg { width: 16px; height: 16px; }

  svg {
    animation: spin 0.9s linear infinite;
    transform-origin: center;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* A spinner exists to say "still working", which a slower sweep still says. */
  @media (prefers-reduced-motion: reduce) {
    svg { animation-duration: 2s; }
  }
</style>
