<script lang="ts">
  export let name: string;
  export let x: number;
  export let y: number;

  $: isTag = name.startsWith('tag:');
  $: displayName = name.replace(/^tag:\s*/, '').replace(/^HEAD -> /, '');
  $: isHead = name.includes('HEAD');
</script>

<g class="ref-badge" transform="translate({x}, {y})">
  <rect
    rx="3"
    ry="3"
    width={displayName.length * 7 + 10}
    height="16"
    y="-8"
    class:tag={isTag}
    class:head={isHead}
    class:branch={!isTag && !isHead}
  />
  <text
    x="5"
    dy="4"
    font-size="11"
    class:tag={isTag}
    class:head={isHead}
  >
    {displayName}
  </text>
</g>

<style>
  rect.branch {
    fill: var(--vscode-badge-background, #007acc);
    opacity: 0.9;
  }
  rect.tag {
    fill: var(--vscode-editorWarning-foreground, #d7ba7d);
    opacity: 0.9;
  }
  rect.head {
    fill: var(--vscode-testing-iconPassed, #6a9955);
    opacity: 0.9;
  }
  text {
    fill: var(--vscode-badge-foreground, #ffffff);
    font-family: var(--vscode-font-family, monospace);
    font-weight: 600;
  }
</style>
