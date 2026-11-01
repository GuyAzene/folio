<script lang="ts">
  import { ChevronRight, FileJson, Plus, RotateCw, Trash2, X } from "@lucide/svelte";
  import { Switch, ToggleGroup } from "bits-ui";
  import type { McpServerView, ToolRuleView } from "../../src/desktop/api.ts";
  import { folio } from "../lib/state.svelte.ts";

  /**
   * The student's MCP servers: services the tutor can use, such as their university's Moodle.
   * Each shows its full command line and the names of its settings, never their values, and
   * which of its tools run without asking.
   */
  const view = $derived(folio.mcp);
  let open = $state<string | null>(null);
  let showLog = $state<string | null>(null);

  $effect(() => {
    void folio.refreshMcp();
  });

  /** The server being added (null id) or changed. */
  let form = $state<{ previous: string | null; mode: "paste" | "fill" } | null>(null);
  let pasted = $state("");
  let id = $state("");
  let command = $state("");
  let args = $state("");
  /** Settings being written: a name, and a value that is only ever sent, never shown. */
  let settings = $state<{ name: string; value: string; known: boolean }[]>([]);
  let removed = $state<string[]>([]);
  let problem = $state("");
  let saving = $state(false);

  function startAdd(): void {
    form = { previous: null, mode: "paste" };
    pasted = "";
    id = "";
    command = "";
    args = "";
    settings = [{ name: "", value: "", known: false }];
    removed = [];
    problem = "";
  }

  function startEdit(server: McpServerView): void {
    form = { previous: server.id, mode: "fill" };
    id = server.id;
    command = server.command;
    args = server.args.join("\n");
    settings = server.env.map((name) => ({ name, value: "", known: true }));
    removed = [];
    problem = "";
  }

  async function save(): Promise<void> {
    if (!form) return;
    saving = true;
    problem = "";
    try {
      if (form.mode === "paste") folio.mcp = await folio.api.addMcpServers(pasted);
      else {
        const env: Record<string, string | null> = {};
        for (const name of removed) env[name] = null;
        for (const setting of settings)
          if (setting.name.trim() && (setting.value || !setting.known))
            env[setting.name.trim()] = setting.value;
        folio.mcp = await folio.api.saveMcpServer(
          {
            id: id.trim(),
            command: command.trim(),
            args: args
              .split("\n")
              .map((arg) => arg.trim())
              .filter(Boolean),
            env,
          },
          form.previous,
        );
      }
      form = null;
    } catch (error) {
      problem = error instanceof Error ? error.message : "Folio couldn't save it.";
    } finally {
      saving = false;
    }
  }

  function remove(server: McpServerView): void {
    folio.confirming = {
      title: `Remove ${server.label}?`,
      body: "Folio stops it and forgets its settings, including any key or password in them. The program itself stays installed.",
      action: "Remove",
      run: async () => {
        await folio.changeMcp((api) => api.removeMcpServer(server.id));
      },
    };
  }

  const STATUS: Record<McpServerView["status"], { text: string; dot: string }> = {
    ready: { text: "Running", dot: "bg-success" },
    starting: { text: "Starting…", dot: "bg-highlight" },
    stopped: { text: "Stopped; starting again soon", dot: "bg-highlight" },
    failed: { text: "Couldn't start", dot: "bg-danger" },
    off: { text: "Off", dot: "bg-text-4" },
  };
  const RULES: { value: ToolRuleView; label: string }[] = [
    { value: "ask", label: "Ask" },
    { value: "allow", label: "Allow" },
    { value: "off", label: "Off" },
  ];

  function hint(hints: McpServerView["tools"][number]["hints"]): string {
    if (hints.readOnly === true) return "says it only reads";
    if (hints.destructive === true) return "says it can delete";
    if (hints.readOnly === false) return "says it can change things";
    return "";
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
  const toggle =
    "h-[24px] rounded-md px-2 text-[12px] font-medium text-text-2 transition-colors data-[state=on]:bg-surface data-[state=on]:text-text data-[state=on]:shadow-[0_1px_2px_#18181b14,0_0_0_1px_#18181b0a] dark:data-[state=on]:bg-selected";
</script>

{#snippet onSwitch(checked: boolean, label: string, change: (on: boolean) => void)}
  <Switch.Root
    {checked}
    onCheckedChange={change}
    aria-label={label}
    class="relative inline-flex h-[18px] w-[30px] shrink-0 items-center rounded-full bg-line-strong transition-colors data-[state=checked]:bg-ink"
  >
    <Switch.Thumb
      class="pointer-events-none block size-[14px] translate-x-[2px] rounded-full bg-surface shadow-1 transition-transform data-[state=checked]:translate-x-[14px] dark:bg-raised"
    />
  </Switch.Root>
{/snippet}

<section class="flex flex-col gap-1 pb-4">
  <span class="font-medium">MCP servers</span>
  <span class="text-[12px] text-text-3"
    >Services the tutor can use, such as your university's Moodle. Folio asks you
    before each call until you allow a tool, and never hands a service your files
    in Folio: it gets only what the tutor writes into a call.</span
  >

  {#if form}
    <div class="mt-2 flex flex-col gap-2 rounded-lg border border-line-subtle p-3">
      {#if !form.previous}
        <ToggleGroup.Root
          type="single"
          value={form.mode}
          onValueChange={(value) => value && form && (form.mode = value as "paste" | "fill")}
          class="flex self-start rounded-lg border border-line-subtle bg-bg p-0.5"
        >
          <ToggleGroup.Item value="paste" class={toggle}>Paste a block</ToggleGroup.Item>
          <ToggleGroup.Item value="fill" class={toggle}>Fill in</ToggleGroup.Item>
        </ToggleGroup.Root>
      {/if}
      {#if form.mode === "paste"}
        <span class="text-[12px] text-text-3"
          >The JSON from the server's instructions, as you would give Claude
          Desktop or Claude Code.</span
        >
        <textarea
          class="{field} min-h-[140px] py-2 font-mono text-[12px] leading-5"
          bind:value={pasted}
          aria-label="Server block"
          spellcheck="false"
          dir="ltr"
          placeholder={'{\n  "mcpServers": {\n    "moodle": { "command": "moodle-mcp" }\n  }\n}'}
          use:focusOnShow
        ></textarea>
      {:else}
        <label class="flex flex-col gap-1 text-[12px] text-text-3"
          >Name
          <input
            class="{field} h-8"
            bind:value={id}
            placeholder="moodle"
            maxlength={64}
            dir="ltr"
            use:focusOnShow
          />
        </label>
        <label class="flex flex-col gap-1 text-[12px] text-text-3"
          >Program
          <input
            class="{field} h-8 font-mono text-[12px]"
            bind:value={command}
            placeholder="moodle-mcp, or its full path"
            spellcheck="false"
            dir="ltr"
          />
        </label>
        <label class="flex flex-col gap-1 text-[12px] text-text-3"
          >Arguments, one per line
          <textarea
            class="{field} min-h-[52px] py-1.5 font-mono text-[12px]"
            bind:value={args}
            spellcheck="false"
            dir="ltr"
          ></textarea>
        </label>
        <span class="text-[12px] text-text-3"
          >Settings, such as a token or a password. Folio keeps them in its own
          file and never shows their values again.</span
        >
        {#each settings as setting, index (index)}
          <div class="flex items-center gap-1.5">
            <input
              class="{field} h-8 w-[40%] font-mono text-[12px]"
              bind:value={setting.name}
              placeholder="MOODLE_TOKEN"
              aria-label="Setting name"
              readonly={setting.known}
              spellcheck="false"
              dir="ltr"
            />
            <input
              class="{field} h-8 flex-1 font-mono text-[12px]"
              type="password"
              bind:value={setting.value}
              placeholder={setting.known ? "Saved; type to replace" : "Value"}
              aria-label="Value of {setting.name || 'setting'}"
              autocomplete="off"
              dir="ltr"
            />
            <button
              type="button"
              class={iconButton}
              aria-label="Remove {setting.name || 'setting'}"
              onclick={() => {
                if (setting.known) removed = [...removed, setting.name];
                settings = settings.filter((_, other) => other !== index);
              }}
            >
              <X size={14} strokeWidth={1.75} />
            </button>
          </div>
        {/each}
        <button
          type="button"
          class="self-start text-[12px] text-text-3 hover:text-text"
          onclick={() => (settings = [...settings, { name: "", value: "", known: false }])}
          >Add a setting</button
        >
      {/if}
      {#if problem}
        <span class="text-[12px] text-danger" role="alert">{problem}</span>
      {/if}
      <div class="flex items-center justify-end gap-2">
        {#if !form.previous}
          <span class="mr-auto text-[12px] text-text-3">It starts off; you turn it on.</span>
        {/if}
        <button class={ghost} onclick={() => (form = null)}>Cancel</button>
        <button
          class={primary}
          disabled={saving || (form.mode === "paste" ? !pasted.trim() : !id.trim() || !command.trim())}
          onclick={() => void save()}>{form.previous ? "Save" : "Add"}</button
        >
      </div>
    </div>
  {/if}

  {#if view?.servers.length}
    <div class="mt-2 flex flex-col divide-y divide-line-subtle">
      {#each view.servers as server (server.id)}
        {@const status = STATUS[server.status]}
        <div class="flex flex-col py-2">
          <div class="flex items-center gap-2.5">
            <button
              class="flex min-w-0 flex-1 items-center gap-2 text-left"
              aria-expanded={open === server.id}
              onclick={() => (open = open === server.id ? null : server.id)}
            >
              <ChevronRight
                size={14}
                strokeWidth={1.75}
                class="shrink-0 text-text-3 transition-transform {open === server.id
                  ? 'rotate-90'
                  : ''}"
              />
              <span class="size-1.5 shrink-0 rounded-full {status.dot}"></span>
              <span class="truncate font-medium" dir="auto">{server.label}</span>
              <span class="truncate text-[12px] text-text-3"
                >{status.text}{server.status === "ready"
                  ? ` · ${server.tools.length} tool${server.tools.length === 1 ? "" : "s"}`
                  : ""}</span
              >
            </button>
            {@render onSwitch(server.enabled, `Use ${server.label}`, (on) =>
              void folio.changeMcp((api) => api.setMcpServerOn(server.id, on)),
            )}
          </div>
          {#if server.status === "failed" && server.error}
            <span class="mt-1 pl-[22px] text-[12px] text-danger" dir="auto">{server.error}</span>
          {/if}
          {#if !server.enabled && open !== server.id}
            <span class="mt-1 truncate pl-[22px] font-mono text-[11.5px] text-text-3" dir="ltr"
              >{[server.command, ...server.args].join(" ")}</span
            >
          {/if}
          {#if open === server.id}
            <div class="mt-2 flex flex-col gap-2 pl-[22px]">
              <div class="flex flex-col gap-0.5">
                <span class="text-[11px] text-text-3"
                  >{server.kind === "remote" ? "Address" : "Runs"}</span
                >
                <span
                  class="rounded-md bg-sunken px-2 py-1 font-mono text-[11.5px] break-all text-text-2 dark:bg-surface"
                  dir="ltr">{[server.command, ...server.args].join(" ")}</span
                >
                {#if server.argWarning}
                  <span class="text-[12px] text-danger"
                    >An argument looks like a key. Arguments show here in full: put
                    keys in its settings instead.</span
                  >
                {/if}
              </div>
              {#if server.env.length || server.headers.length}
                <span class="text-[12px] text-text-3"
                  >Settings: <span dir="ltr">{[...server.env, ...server.headers].join(", ")}</span
                  > (values hidden)</span
                >
              {/if}
              {#if server.instructions}
                <span class="line-clamp-3 text-[12px] text-text-3" dir="auto"
                  >{server.instructions}</span
                >
              {/if}
              {#if server.log}
                <button
                  type="button"
                  class="self-start text-[12px] text-text-3 hover:text-text"
                  onclick={() => (showLog = showLog === server.id ? null : server.id)}
                  >{showLog === server.id ? "Hide details" : "Details"}</button
                >
                {#if showLog === server.id}
                  <pre
                    class="scroll-quiet max-h-[160px] overflow-auto rounded-md bg-sunken px-2 py-1 font-mono text-[11px] whitespace-pre-wrap text-text-3 dark:bg-surface"
                    dir="ltr">{server.log}</pre>
                {/if}
              {/if}
              {#if server.tools.length}
                <div class="flex items-center justify-between gap-3 pt-1">
                  <span class="text-[12px] text-text-2"
                    >Allow every tool without asking</span
                  >
                  {@render onSwitch(
                    server.approval === "allow",
                    `Allow every ${server.label} tool`,
                    (on) =>
                      void folio.changeMcp((api) =>
                        api.setMcpServerApproval(server.id, on ? "allow" : "ask"),
                      ),
                  )}
                </div>
                <div class="flex flex-col divide-y divide-line-subtle">
                  {#each server.tools as tool (tool.name)}
                    <div class="flex items-start gap-3 py-1.5">
                      <div class="flex min-w-0 flex-1 flex-col">
                        <span class="text-[12.5px]" dir="ltr">{tool.title ?? tool.name}</span>
                        <span class="line-clamp-2 text-[12px] text-text-3" dir="auto"
                          >{tool.description}{hint(tool.hints)
                            ? ` · ${server.label} ${hint(tool.hints)}`
                            : ""}</span
                        >
                      </div>
                      <ToggleGroup.Root
                        type="single"
                        value={server.approval === "allow" && tool.rule === "ask"
                          ? "allow"
                          : tool.rule}
                        disabled={server.approval === "allow"}
                        onValueChange={(value) =>
                          value &&
                          void folio.changeMcp((api) =>
                            api.setMcpToolRule(server.id, tool.name, value as ToolRuleView),
                          )}
                        class="flex shrink-0 rounded-lg border border-line-subtle bg-bg p-0.5 data-[disabled]:opacity-60"
                        aria-label="When {tool.name} runs"
                      >
                        {#each RULES as rule (rule.value)}
                          <ToggleGroup.Item value={rule.value} class={toggle}
                            >{rule.label}</ToggleGroup.Item
                          >
                        {/each}
                      </ToggleGroup.Root>
                    </div>
                  {/each}
                </div>
              {/if}
              <div class="flex flex-wrap gap-2 pt-1">
                {#if server.enabled}
                  <button
                    class={ghost}
                    onclick={() => void folio.changeMcp((api) => api.restartMcpServer(server.id))}
                  >
                    <RotateCw size={14} strokeWidth={1.75} /> Restart
                  </button>
                {/if}
                {#if server.kind === "local"}
                  <button class={ghost} onclick={() => startEdit(server)}>Edit</button>
                {/if}
                <button class={ghost} onclick={() => remove(server)}>
                  <Trash2 size={14} strokeWidth={1.75} /> Remove
                </button>
              </div>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else if view && !form}
    <span class="mt-2 text-[12px] text-text-3">You haven't added a server yet.</span>
  {/if}

  {#if view?.problems.length}
    {#each view.problems as each (each)}
      <span class="text-[12px] text-danger" dir="auto">mcp.json: {each}</span>
    {/each}
  {/if}

  {#if !form}
    <div class="mt-2 flex flex-wrap gap-2">
      <button class={ghost} onclick={startAdd}>
        <Plus size={14} strokeWidth={1.75} /> Add server
      </button>
      <button
        class={ghost}
        onclick={() => void folio.changeMcp((api) => api.revealMcpConfig())}
      >
        <FileJson size={14} strokeWidth={1.75} /> Show mcp.json
      </button>
    </div>
  {/if}
</section>
