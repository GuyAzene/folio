<script lang="ts">
  import {
    FolderOpen,
    FolderPlus,
    Pencil,
    Plus,
    X,
  } from "@lucide/svelte";
  import { Switch } from "bits-ui";
  import type { SkillView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The student's routines (Agent Skills): Folio's own, which they write here, and the skills they
   * keep for other agents, which start off. Folio reads instructions and text files only.
   */
  const view = $derived(folio.skills);
  const own = $derived(view?.skills.filter((skill) => skill.source === "folio") ?? []);
  /** Other agents' skills, grouped by where they came from, in Folio's order. */
  const others = $derived.by(() => {
    const groups = new Map<string, SkillView[]>();
    for (const skill of view?.skills ?? [])
      if (skill.source !== "folio")
        groups.set(skill.from, [...(groups.get(skill.from) ?? []), skill]);
    return [...groups];
  });

  $effect(() => {
    void folio.refreshSkills();
  });

  /** The routine being written: a new one, or one of Folio's own by name. */
  let editing = $state<{ name: string | null } | null>(null);
  let name = $state("");
  let description = $state("");
  let body = $state("");
  let text = $state("");
  let revision = $state("");
  let problem = $state("");
  let saving = $state(false);

  function startNew(): void {
    editing = { name: null };
    name = "";
    description = "";
    body = "";
    problem = "";
  }

  async function startEdit(skill: SkillView): Promise<void> {
    problem = "";
    try {
      const read = await folio.api.readSkill(skill.name);
      text = read.text;
      revision = read.revision;
      editing = { name: skill.name };
    } catch (error) {
      folio.error = error instanceof Error ? error.message : "Folio couldn't open it.";
    }
  }

  async function save(): Promise<void> {
    if (!editing) return;
    saving = true;
    problem = "";
    try {
      const target = editing.name;
      folio.skills = target
        ? await folio.api.saveSkill(target, text, revision)
        : await folio.api.createSkill({ name: name.trim(), description, body });
      editing = null;
    } catch (error) {
      problem = error instanceof Error ? error.message : "Folio couldn't save it.";
    } finally {
      saving = false;
    }
  }

  function setOn(skill: SkillView, on: boolean): void {
    void folio.changeSkills((api) => api.setSkillOn(skill.key, on));
  }

  /** Lowercase letters, digits and single hyphens, as the name is typed. */
  function slug(value: string): string {
    return value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-/, "")
      .slice(0, 64);
  }

  function focusOnShow(node: HTMLElement): void {
    requestAnimationFrame(() => node.focus());
  }

  const field =
    "w-full rounded-md border border-line-strong bg-surface px-2.5 text-[13px] outline-none transition-colors placeholder:text-text-4 focus:border-ink dark:bg-sunken";
  const ghost =
    "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-line bg-surface px-3 font-medium shadow-1 hover:bg-hover dark:bg-raised";
  const primary =
    "h-8 shrink-0 rounded-md bg-ink px-3 font-medium text-on-ink shadow-1 hover:opacity-90 disabled:opacity-50";
  const iconButton =
    "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-3 hover:bg-hover hover:text-text";
</script>

{#snippet toggle(skill: SkillView)}
  <Switch.Root
    checked={skill.on}
    onCheckedChange={(on) => setOn(skill, on)}
    aria-label="Use {skill.name}"
    class="relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full bg-line-strong transition-colors data-[state=checked]:bg-ink"
  >
    <Switch.Thumb
      class="pointer-events-none block size-[14px] translate-x-[2px] rounded-full bg-surface shadow-1 transition-transform data-[state=checked]:translate-x-[14px] dark:bg-raised"
    />
  </Switch.Root>
{/snippet}

{#snippet row(skill: SkillView, own: boolean)}
  <div class="flex items-start gap-3 py-2">
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
        <span class="font-medium" dir="ltr">/{skill.name}</span>
        {#if !skill.model}
          <span class="text-[11px] text-text-3">you start it</span>
        {/if}
      </span>
      <span class="line-clamp-2 text-[12px] text-text-3" dir="auto"
        >{skill.description}</span
      >
      {#if skill.hiddenBy}
        <span class="text-[12px] text-text-3"
          >Not used: {skill.hiddenBy} has the same name.</span
        >
      {/if}
      {#if skill.allowedTools}
        <span class="text-[12px] text-text-3"
          >Written for an agent that runs tools; Folio follows its instructions
          only.</span
        >
      {/if}
      {#if skill.note}
        <span class="text-[12px] text-text-3">{skill.note}</span>
      {/if}
    </div>
    {#if own}
      <button
        class={iconButton}
        title="Edit"
        aria-label="Edit {skill.name}"
        onclick={() => void startEdit(skill)}
      >
        <Pencil size={14} strokeWidth={1.75} />
      </button>
    {/if}
    <button
      class={iconButton}
      title="Show in Finder"
      aria-label="Show {skill.name} in Finder"
      onclick={() => void folio.changeSkills(async (api) => (await api.revealSkill(skill.key), null))}
    >
      <FolderOpen size={14} strokeWidth={1.75} />
    </button>
    <span class="pt-1">{@render toggle(skill)}</span>
  </div>
{/snippet}

<section class="flex flex-col gap-1 pb-4">
  <span class="font-medium">Your routines</span>
  <span class="text-[12px] text-text-3"
    >How you like Folio to teach and work, in your own words. Folio follows one
    when it fits your question, or start one yourself by typing / and its name
    in a message.</span
  >
  {#if editing}
    <div class="mt-2 flex flex-col gap-2 rounded-lg border border-line-subtle p-3">
      {#if editing.name}
        <span class="text-[12px] text-text-3"
          >Editing <span dir="ltr">{editing.name}/SKILL.md</span>. Keep the
          lines between the dashes: they hold its name and description.</span
        >
        <textarea
          class="{field} min-h-[220px] py-2 font-mono text-[12px] leading-5"
          bind:value={text}
          aria-label="SKILL.md"
          spellcheck="false"
          dir="auto"
          use:focusOnShow
        ></textarea>
      {:else}
        <input
          class="{field} h-8"
          value={name}
          oninput={(event) => {
            name = slug(event.currentTarget.value);
            event.currentTarget.value = name;
          }}
          placeholder="quiz-me"
          aria-label="Name"
          maxlength={64}
          dir="ltr"
          use:focusOnShow
        />
        <textarea
          class="{field} min-h-[52px] py-1.5"
          bind:value={description}
          placeholder="When Folio should use it, in a sentence: Quiz me one question at a time on what I name."
          aria-label="Description"
          maxlength={1024}
          dir="auto"
        ></textarea>
        <textarea
          class="{field} min-h-[140px] py-1.5"
          bind:value={body}
          placeholder="The instructions: what to do, step by step."
          aria-label="Instructions"
          dir="auto"
        ></textarea>
      {/if}
      {#if problem}
        <span class="text-[12px] text-danger" role="alert">{problem}</span>
      {/if}
      <div class="flex justify-end gap-2">
        <button class={ghost} onclick={() => (editing = null)}>Cancel</button>
        <button
          class={primary}
          disabled={saving || (!editing.name && (!name || !description.trim()))}
          onclick={() => void save()}>{editing.name ? "Save" : "Create"}</button
        >
      </div>
    </div>
  {/if}
  {#if own.length}
    <div class="mt-1 flex flex-col divide-y divide-line-subtle">
      {#each own as skill (skill.key)}
        {@render row(skill, true)}
      {/each}
    </div>
  {:else if view && !editing}
    <span class="mt-2 text-[12px] text-text-3">You have no routines yet.</span>
  {/if}
  {#if !editing}
    <div class="mt-2 flex flex-wrap gap-2">
      <button class={ghost} onclick={startNew}>
        <Plus size={14} strokeWidth={1.75} /> New routine
      </button>
      <button
        class={ghost}
        onclick={() => void folio.changeSkills(async (api) => (await api.revealSkill(null), null))}
      >
        <FolderOpen size={14} strokeWidth={1.75} /> Open folder
      </button>
    </div>
  {/if}
</section>

<div class="h-px bg-line-subtle"></div>

<section class="flex flex-col gap-1 pt-4">
  <span class="font-medium">From other apps</span>
  <span class="text-[12px] text-text-3"
    >Skills you keep for Claude Code, Codex and other agents. They start off:
    turn on the ones that help you study. Folio reads their instructions and
    text files, and never runs their scripts.</span
  >
  {#each others as [from, skills] (from)}
    <span class="mt-3 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase" dir="auto"
      >{from}</span
    >
    <div class="flex flex-col divide-y divide-line-subtle">
      {#each skills as skill (skill.key)}
        {@render row(skill, false)}
      {/each}
    </div>
  {:else}
    {#if view}
      <span class="mt-2 text-[12px] text-text-3"
        >No skills found in ~/.agents/skills, ~/.claude/skills or
        ~/.codex/skills.</span
      >
    {/if}
  {/each}
  {#if view?.folders.length}
    <span class="mt-3 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
      >Folders you added</span
    >
    {#each view.folders as folder (folder)}
      <div class="flex items-center gap-2 py-1">
        <span class="min-w-0 flex-1 truncate text-[12px]" dir="ltr">{folder}</span>
        <button
          class={iconButton}
          aria-label="Stop reading {folder}"
          title="Stop reading this folder"
          onclick={() => void folio.changeSkills((api) => api.removeSkillFolder(folder))}
        >
          <X size={14} strokeWidth={1.75} />
        </button>
      </div>
    {/each}
  {/if}
  <button
    class="{ghost} mt-2 self-start"
    onclick={() => void folio.changeSkills((api) => api.addSkillFolder())}
  >
    <FolderPlus size={14} strokeWidth={1.75} /> Add a folder…
  </button>
  {#if view?.skipped.length}
    <span class="mt-4 text-[11px] font-medium tracking-[0.06em] text-text-3 uppercase"
      >Couldn't read</span
    >
    {#each view.skipped as skipped (skipped.key)}
      <span class="py-0.5 text-[12px] text-text-3"
        ><span dir="ltr">{skipped.key}</span>: {skipped.reason}.</span
      >
    {/each}
  {/if}
</section>
