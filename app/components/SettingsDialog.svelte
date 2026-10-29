<script lang="ts">
  import { X } from "@lucide/svelte";
  import { Dialog, ToggleGroup } from "bits-ui";
  import { folio, type ThemePreference } from "../lib/state.svelte.ts";
  import ProviderMark from "./ProviderMark.svelte";

  const themes: { value: ThemePreference; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];
</script>

<Dialog.Root bind:open={folio.settingsOpen}>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-40 animate-[folio-fade_150ms_ease-out] bg-[#18181b]/20 backdrop-blur-[2px] dark:bg-black/50"
    />
    <Dialog.Content
      class="fixed top-1/2 left-1/2 z-50 flex w-[min(480px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <div
        class="flex animate-[folio-scale_180ms_var(--ease-out-quint)] flex-col"
      >
        <div class="flex items-center justify-between px-5 pt-4 pb-1">
          <Dialog.Title class="text-[15px] font-semibold tracking-[-0.01em]"
            >Settings</Dialog.Title
          >
          <Dialog.Close
            class="inline-flex size-7 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text"
            aria-label="Close"
          >
            <X size={15} strokeWidth={1.75} />
          </Dialog.Close>
        </div>
        <Dialog.Description class="sr-only"
          >Appearance and account settings.</Dialog.Description
        >

        <section class="flex items-center justify-between gap-4 px-5 py-4">
          <div class="flex flex-col gap-0.5">
            <span class="font-medium">Appearance</span>
            <span class="text-[12px] text-text-3">Light is the default.</span>
          </div>
          <ToggleGroup.Root
            type="single"
            value={folio.theme}
            onValueChange={(value) =>
              value && folio.setTheme(value as ThemePreference)}
            class="flex rounded-lg border border-line-subtle bg-bg p-0.5"
          >
            {#each themes as theme (theme.value)}
              <ToggleGroup.Item
                value={theme.value}
                class="h-[26px] rounded-md px-2.5 text-[12px] font-medium text-text-2 transition-colors data-[state=on]:bg-surface data-[state=on]:text-text data-[state=on]:shadow-[0_1px_2px_#18181b14,0_0_0_1px_#18181b0a] dark:data-[state=on]:bg-selected"
              >
                {theme.label}
              </ToggleGroup.Item>
            {/each}
          </ToggleGroup.Root>
        </section>

        <div class="mx-5 h-px bg-line-subtle"></div>

        <section class="flex items-center justify-between gap-4 px-5 py-4">
          <div class="flex min-w-0 flex-col gap-0.5">
            <span class="font-medium">Web search</span>
            <span class="text-[12px] text-text-3"
              >The tutor may search the internet when you want more than your
              course material. Only a short query leaves Folio.</span
            >
          </div>
          <ToggleGroup.Root
            type="single"
            value={folio.webSearch ? "on" : "off"}
            onValueChange={(value) => value && folio.setWebSearch(value === "on")}
            class="flex shrink-0 rounded-lg border border-line-subtle bg-bg p-0.5"
          >
            {#each [{ value: "on", label: "On" }, { value: "off", label: "Off" }] as option (option.value)}
              <ToggleGroup.Item
                value={option.value}
                class="h-[26px] rounded-md px-2.5 text-[12px] font-medium text-text-2 transition-colors data-[state=on]:bg-surface data-[state=on]:text-text data-[state=on]:shadow-[0_1px_2px_#18181b14,0_0_0_1px_#18181b0a] dark:data-[state=on]:bg-selected"
              >
                {option.label}
              </ToggleGroup.Item>
            {/each}
          </ToggleGroup.Root>
        </section>

        <div class="mx-5 h-px bg-line-subtle"></div>

        <section class="flex flex-col gap-1 px-5 py-4">
          <span class="mb-1 font-medium">Subscriptions</span>
          <div class="flex items-center justify-between gap-4 py-1">
            <div class="flex items-center gap-2.5">
              <ProviderMark provider="openai" name="ChatGPT" size={16} />
              <div class="flex flex-col gap-0.5">
                <span>ChatGPT</span>
                <span class="flex items-center gap-1.5 text-[12px] text-text-3">
                  <span
                    class="size-1.5 rounded-full {folio.connection.connected
                      ? 'bg-success'
                      : 'bg-text-4'}"
                  ></span>
                  {folio.connection.connected
                    ? "Connected with your plan"
                    : folio.connection.signingIn
                      ? "Waiting for the browser"
                      : "Not connected"}
                </span>
              </div>
            </div>
            {#if folio.connection.connected}
              <button
                class="h-8 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover"
                onclick={() => folio.api.signOut()}>Sign out</button
              >
            {:else if folio.connection.signingIn}
              <button
                class="h-8 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover"
                onclick={() => folio.api.cancelSignIn()}>Cancel</button
              >
            {:else}
              <button
                class="h-8 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 hover:opacity-90"
                onclick={() => folio.api.signIn()}>Connect</button
              >
            {/if}
          </div>
          {#each folio.subscriptions.filter((subscription) => !subscription.available) as subscription (subscription.provider)}
            <div class="flex items-center justify-between gap-4 py-1">
              <div class="flex items-center gap-2.5">
                <ProviderMark
                  provider={subscription.provider}
                  name={subscription.name}
                  size={16}
                />
                <div class="flex flex-col gap-0.5">
                  <span>{subscription.name}</span>
                  <span class="text-[12px] text-text-3">Not available yet</span>
                </div>
              </div>
            </div>
          {/each}
        </section>

        <div class="mx-5 h-px bg-line-subtle"></div>

        <section class="flex items-center justify-between gap-4 px-5 pt-4 pb-5">
          <div class="flex flex-col gap-0.5">
            <span class="font-medium">New chats use</span>
            <span class="text-[12px] text-text-3"
              >Pick another in the composer. Chats are saved on this Mac.</span
            >
          </div>
          <span class="text-text-2">{folio.modelName(folio.modelChoice)}</span>
        </section>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
