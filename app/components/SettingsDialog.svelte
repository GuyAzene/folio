<script lang="ts">
  import {
    ArrowUpRight,
    Cpu,
    KeyRound,
    Plug,
    ScrollText,
    SlidersHorizontal,
    Tags,
    X,
  } from "@lucide/svelte";
  import { Dialog, ToggleGroup } from "bits-ui";
  import {
    folio,
    type SettingsSection,
    type ThemePreference,
  } from "../lib/state.svelte.ts";
  import CategorySettings from "./CategorySettings.svelte";
  import ConnectionSettings from "./ConnectionSettings.svelte";
  import ModelSettings from "./ModelSettings.svelte";
  import SkillSettings from "./SkillSettings.svelte";
  import McpSettings from "./McpSettings.svelte";

  const themes: { value: ThemePreference; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  const SECTIONS: {
    value: SettingsSection;
    label: string;
    icon: typeof Cpu;
  }[] = [
    { value: "general", label: "General", icon: SlidersHorizontal },
    { value: "connections", label: "Connections", icon: KeyRound },
    { value: "models", label: "Models", icon: Cpu },
    { value: "categories", label: "Categories", icon: Tags },
    { value: "skills", label: "Skills", icon: ScrollText },
    { value: "mcp", label: "MCP servers", icon: Plug },
  ];

  const toggle =
    "h-[26px] rounded-md px-2.5 text-[12px] font-medium text-text-2 transition-colors data-[state=on]:bg-surface data-[state=on]:text-text data-[state=on]:shadow-[0_1px_2px_#18181b14,0_0_0_1px_#18181b0a] dark:data-[state=on]:bg-selected";
</script>

<Dialog.Root bind:open={folio.settingsOpen}>
  <Dialog.Portal>
    <Dialog.Overlay
      class="fixed inset-0 z-40 animate-[folio-fade_150ms_ease-out] bg-[#18181b]/20 backdrop-blur-[2px] dark:bg-black/50"
    />
    <Dialog.Content
      onInteractOutside={(event) => {
        // A button that swapped itself out as it was clicked (Add key, Choose…) was inside.
        if (event.target instanceof Node && !event.target.isConnected)
          event.preventDefault();
      }}
      class="fixed top-1/2 left-1/2 z-50 flex h-[min(600px,calc(100vh-48px))] w-[min(720px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl border border-line-subtle bg-raised shadow-3 outline-none"
    >
      <div
        class="flex min-h-0 flex-1 animate-[folio-scale_180ms_var(--ease-out-quint)] flex-col"
      >
        <div class="flex items-center justify-between px-5 pt-4 pb-2">
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
          >Appearance, connections, which model does what, your categories of
          course files, your routines and your services.</Dialog.Description
        >

        <div class="flex min-h-0 flex-1 max-sm:flex-col">
          <nav
            class="scroll-quiet flex shrink-0 gap-0.5 px-3 pb-3 sm:w-[168px] sm:flex-col max-sm:overflow-x-auto max-sm:border-b max-sm:border-line-subtle"
            aria-label="Settings sections"
          >
            {#each SECTIONS as section (section.value)}
              {@const Icon = section.icon}
              <button
                class="flex h-8 shrink-0 items-center gap-2.5 rounded-md px-2.5 text-left whitespace-nowrap transition-colors {folio.settingsSection ===
                section.value
                  ? 'bg-hover font-medium text-text'
                  : 'text-text-2 hover:bg-hover hover:text-text'}"
                aria-current={folio.settingsSection === section.value
                  ? "page"
                  : undefined}
                onclick={() => (folio.settingsSection = section.value)}
              >
                <Icon size={15} strokeWidth={1.75} />
                {section.label}
              </button>
            {/each}
          </nav>

          <div
            class="scroll-quiet min-h-0 flex-1 overflow-y-auto px-5 pt-1 pb-5 sm:pl-2"
          >
            {#if folio.settingsSection === "connections"}
              <ConnectionSettings />
            {:else if folio.settingsSection === "models"}
              <ModelSettings />
            {:else if folio.settingsSection === "categories"}
              <CategorySettings />
            {:else if folio.settingsSection === "skills"}
              <SkillSettings />
            {:else if folio.settingsSection === "mcp"}
              <McpSettings />
            {:else}
              <section class="flex items-center justify-between gap-4 pb-4">
                <div class="flex flex-col gap-0.5">
                  <span class="font-medium">Appearance</span>
                  <span class="text-[12px] text-text-3">Light is the default.</span
                  >
                </div>
                <ToggleGroup.Root
                  type="single"
                  value={folio.theme}
                  onValueChange={(value) =>
                    value && folio.setTheme(value as ThemePreference)}
                  class="flex rounded-lg border border-line-subtle bg-bg p-0.5"
                >
                  {#each themes as theme (theme.value)}
                    <ToggleGroup.Item value={theme.value} class={toggle}>
                      {theme.label}
                    </ToggleGroup.Item>
                  {/each}
                </ToggleGroup.Root>
              </section>

              <div class="h-px bg-line-subtle"></div>

              <section class="flex items-center justify-between gap-4 py-4">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-medium">Web search</span>
                  <span class="text-[12px] text-text-3"
                    >The tutor may search the internet when you want more than
                    your course material. Only a short query leaves Folio.</span
                  >
                </div>
                <ToggleGroup.Root
                  type="single"
                  value={folio.webSearch ? "on" : "off"}
                  onValueChange={(value) =>
                    value && folio.setWebSearch(value === "on")}
                  class="flex shrink-0 rounded-lg border border-line-subtle bg-bg p-0.5"
                >
                  {#each [{ value: "on", label: "On" }, { value: "off", label: "Off" }] as option (option.value)}
                    <ToggleGroup.Item value={option.value} class={toggle}>
                      {option.label}
                    </ToggleGroup.Item>
                  {/each}
                </ToggleGroup.Root>
              </section>

              <div class="h-px bg-line-subtle"></div>

              <section class="flex items-center justify-between gap-4 py-4">
                <div class="flex flex-col gap-0.5">
                  <span class="font-medium">New chats use</span>
                  <span class="text-[12px] text-text-3"
                    >Pick another in the composer. Chats are saved on this Mac.</span
                  >
                </div>
                <button
                  class="text-text-2 hover:text-text"
                  onclick={() => (folio.settingsSection = "models")}
                  >{folio.modelName(folio.modelChoice)}</button
                >
              </section>

              <div class="h-px bg-line-subtle"></div>

              <section class="flex items-center justify-between gap-4 pt-4">
                <div class="flex min-w-0 flex-col gap-0.5">
                  <span class="font-medium">Updates</span>
                  <span class="text-[12px] text-text-3"
                    >{folio.release ? `Folio ${folio.release.version}. ` : ""}Checks
                    GitHub once a day for a newer release{folio.release?.update
                      ? ", and downloads it when you click Update"
                      : ""}; nothing about you is sent.</span
                  >
                  {#if folio.release?.newer}
                    {@const newer = folio.release.newer}
                    {@const update = folio.release.update}
                    {@const action = "font-medium text-text hover:underline"}
                    <div class="mt-1 flex flex-wrap items-center gap-x-2 text-[12px]">
                      <span
                        class="size-1.5 shrink-0 rounded-full bg-highlight ring-2 ring-highlight/30"
                      ></span>
                      {#if update?.step === "downloading"}
                        <span class="text-text-2" role="status"
                          >{update.percent < 100
                            ? `Downloading Folio ${newer.version}, ${update.percent}%`
                            : `Getting Folio ${newer.version} ready`}</span
                        >
                      {:else if update?.step === "ready"}
                        <span class="text-text-2">Folio {newer.version} is downloaded.</span>
                        <button
                          class={action}
                          onclick={() => folio.restartToUpdate(newer.version)}
                          >Restart to update</button
                        >
                      {:else if update}
                        <span class="text-text-2"
                          >{update.step === "failed"
                            ? `Couldn't update to Folio ${newer.version}.`
                            : `Folio ${newer.version} is out.`}</span
                        >
                        <button class={action} onclick={() => void folio.updateFolio(newer.version)}
                          >{update.step === "failed" ? "Try again" : "Update"}</button
                        >
                      {:else}
                        <span class="text-text-2">Folio {newer.version} is out.</span>
                      {/if}
                      <a
                        href={newer.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        class="flex items-center gap-0.5 {update
                          ? 'text-text-3 hover:text-text'
                          : action} no-underline hover:underline"
                        >See what's new
                        <ArrowUpRight size={12} strokeWidth={2} class="text-text-3" /></a
                      >
                    </div>
                  {/if}
                </div>
                <ToggleGroup.Root
                  type="single"
                  value={folio.release ? (folio.release.on ? "on" : "off") : ""}
                  onValueChange={(value) =>
                    value && void folio.setUpdates(value === "on")}
                  aria-label="Check for updates"
                  class="flex shrink-0 rounded-lg border border-line-subtle bg-bg p-0.5"
                >
                  {#each [{ value: "on", label: "On" }, { value: "off", label: "Off" }] as option (option.value)}
                    <ToggleGroup.Item value={option.value} class={toggle}>
                      {option.label}
                    </ToggleGroup.Item>
                  {/each}
                </ToggleGroup.Root>
              </section>
            {/if}
          </div>
        </div>
      </div>
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>
