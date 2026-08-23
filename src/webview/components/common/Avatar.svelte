<script lang="ts">
  import { getGravatarUrl, getAvatarColor, getInitials } from '../../lib/gravatar';

  export let name: string = '';
  export let email: string = '';
  export let size: number = 20;

  // Ask Gravatar for d=404 so a missing profile image fails instead of returning
  // a random identicon. On failure we render initials, which reads as intentional.
  let failed = false;
  $: src = email ? getGravatarUrl(email, size, '404') : '';
  // Reset the failure flag whenever the identity changes.
  $: if (email || name) failed = false;

  $: initials = getInitials(name, email);
  $: bg = getAvatarColor(email || name);
  $: fontSize = Math.max(8, Math.round(size * 0.42));
</script>

{#if src && !failed}
  <img
    {src}
    alt={name || email}
    title={name || email}
    class="avatar"
    width={size}
    height={size}
    style="width: {size}px; height: {size}px;"
    on:error={() => { failed = true; }}
  />
{:else}
  <span
    class="avatar avatar-initials"
    title={name || email}
    aria-label={name || email}
    style="width: {size}px; height: {size}px; background: {bg}; font-size: {fontSize}px;"
  >{initials}</span>
{/if}

<style>
  .avatar {
    border-radius: 50%;
    flex-shrink: 0;
    display: inline-block;
    object-fit: cover;
  }

  .avatar-initials {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: #1e1e1e;
    font-weight: 700;
    letter-spacing: 0.02em;
    line-height: 1;
    user-select: none;
  }
</style>
