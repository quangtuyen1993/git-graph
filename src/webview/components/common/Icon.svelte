<script lang="ts">
  import { iconPaths, type IconName } from '../../lib/icons';

  export let name: IconName;
  export let size = 16;

  $: path = iconPaths[name];
</script>

{#if path}
  <svg
    class="icon"
    width={size}
    height={size}
    viewBox="0 0 16 16"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
  >
    <path d={path} />
  </svg>
{/if}

<style>
  .icon {
    display: block;
    flex-shrink: 0;
  }
</style>
