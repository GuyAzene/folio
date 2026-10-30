<script lang="ts">
  import { LoaderCircle } from "@lucide/svelte";
  import { folio } from "../lib/state.svelte.ts";
  import ProviderMark from "./ProviderMark.svelte";

  /**
   * The ChatGPT plan, signed in through the browser, and the services Folio reaches with the
   * student's own API key. A key is checked with its provider before Folio keeps it, and never
   * comes back to the window.
   */
  const chatgpt = $derived(folio.connection("chatgpt"));
  const keys = $derived(
    folio.models.connections.filter((connection) => connection.kind === "key"),
  );

  /** The key being typed, by connection; a row with an entry here shows its field. */
  let drafts = $state<Record<string, string>>({});
  let checking = $state<string | null>(null);
  let problems = $state<Record<string, string>>({});

  const PLACEHOLDERS: Record<string, string> = {
    openai: "sk-…",
    anthropic: "sk-ant-…",
    google: "AIza…",
    openrouter: "sk-or-…",
  };

  async function save(id: string): Promise<void> {
    checking = id;
    problems = { ...problems, [id]: "" };
    try {
      await folio.saveKey(id, drafts[id] ?? "");
      const { [id]: _saved, ...rest } = drafts;
      drafts = rest;
    } catch (error) {
      problems = {
        ...problems,
        [id]:
          error instanceof Error ? error.message : "Folio couldn't save the key.",
      };
    } finally {
      checking = null;
    }
  }

  function cancel(id: string): void {
    const { [id]: _dropped, ...rest } = drafts;
    drafts = rest;
    problems = { ...problems, [id]: "" };
  }

  /** Focuses a field as it appears; the dialog would otherwise keep focus on its first button. */
  function focusOnShow(node: HTMLInputElement): void {
    requestAnimationFrame(() => node.focus());
  }

  const ghost =
    "h-8 shrink-0 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover";
  const primary =
    "h-8 shrink-0 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 hover:opacity-90 disabled:opacity-50";
</script>

<section class="flex flex-col gap-1">
  <span class="font-medium">Subscription</span>
  <span class="mb-2 text-[12px] text-text-3"
    >Your plan pays for what Folio asks. Only ChatGPT can sign in so far.</span
  >
  <div class="flex items-center justify-between gap-4 py-1">
    <div class="flex items-center gap-2.5">
      <ProviderMark provider="chatgpt" name="ChatGPT" size={16} />
      <div class="flex flex-col gap-0.5">
        <span>ChatGPT</span>
        <span class="flex items-center gap-1.5 text-[12px] text-text-3">
          <span
            class="size-1.5 rounded-full {chatgpt?.connected
              ? 'bg-success'
              : 'bg-text-4'}"
          ></span>
          {chatgpt?.connected
            ? "Connected with your plan"
            : chatgpt?.signingIn
              ? "Waiting for the browser"
              : "Not connected"}
        </span>
      </div>
    </div>
    {#if chatgpt?.connected}
      <button class={ghost} onclick={() => folio.api.signOut()}>Sign out</button>
    {:else if chatgpt?.signingIn}
      <button class={ghost} onclick={() => folio.api.cancelSignIn()}
        >Cancel</button
      >
    {:else}
      <button class={primary} onclick={() => folio.api.signIn()}>Connect</button>
    {/if}
  </div>
</section>

<div class="my-4 h-px bg-line-subtle"></div>

<section class="flex flex-col gap-1">
  <span class="font-medium">API keys</span>
  <span class="mb-2 text-[12px] text-text-3"
    >Each provider bills its key for what Folio asks. Keys stay in Folio's folder on
    this Mac and are never shown again.</span
  >
  {#each keys as connection (connection.id)}
    {@const draft = drafts[connection.id]}
    <div class="flex flex-col gap-2 py-1.5">
      <div class="flex items-center justify-between gap-4">
        <div class="flex min-w-0 items-center gap-2.5">
          <ProviderMark
            provider={connection.id}
            name={connection.name}
            size={16}
          />
          <div class="flex min-w-0 flex-col gap-0.5">
            <span>{connection.name}</span>
            <span class="flex items-center gap-1.5 text-[12px] text-text-3">
              <span
                class="size-1.5 rounded-full {connection.connected
                  ? 'bg-success'
                  : 'bg-text-4'}"
              ></span>
              {connection.connected ? "Key saved" : "No key"}
            </span>
          </div>
        </div>
        {#if draft === undefined}
          {#if connection.connected}
            <div class="flex gap-2">
              <button
                class={ghost}
                onclick={() => (drafts = { ...drafts, [connection.id]: "" })}
                >Replace</button
              >
              <button
                class={ghost}
                onclick={() => void folio.removeKey(connection.id)}
                >Remove</button
              >
            </div>
          {:else}
            <button
              class={primary}
              onclick={() => (drafts = { ...drafts, [connection.id]: "" })}
              >Add key</button
            >
          {/if}
        {/if}
      </div>
      {#if draft !== undefined}
        <form
          class="flex items-center gap-2 pl-[26px]"
          onsubmit={(event) => {
            event.preventDefault();
            void save(connection.id);
          }}
        >
          <input
            use:focusOnShow
            type="password"
            autocomplete="off"
            spellcheck="false"
            aria-label="{connection.name} API key"
            placeholder={PLACEHOLDERS[connection.id] ?? "API key"}
            class="h-8 min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 font-mono text-[12px] outline-none focus:border-line-strong"
            value={draft}
            oninput={(event) =>
              (drafts = {
                ...drafts,
                [connection.id]: event.currentTarget.value,
              })}
            onkeydown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                cancel(connection.id);
              }
            }}
          />
          <button
            type="submit"
            class="{primary} inline-flex items-center gap-1.5"
            disabled={!draft.trim() || checking === connection.id}
          >
            {#if checking === connection.id}
              <LoaderCircle size={13} class="animate-spin" />
              Checking
            {:else}
              Save
            {/if}
          </button>
          <button type="button" class={ghost} onclick={() => cancel(connection.id)}
            >Cancel</button
          >
        </form>
        {#if problems[connection.id]}
          <p class="pl-[26px] text-[12px] text-danger" role="alert">
            {problems[connection.id]}
          </p>
        {/if}
      {/if}
    </div>
  {/each}
</section>
