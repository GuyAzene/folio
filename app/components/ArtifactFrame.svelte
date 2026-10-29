<script lang="ts">
  import { folio } from "../lib/state.svelte.ts";
  import {
    claimLiveFrame,
    FRAME_MIN,
    FRAME_SILENCE,
    frameMessage,
    rateLimit,
  } from "../lib/frames.ts";

  /**
   * A demo in its sealed frame. This is the only place Folio creates an iframe: sandboxed with
   * scripts only (an opaque origin with no way back into Folio), no permissions, loaded from the
   * main process's demo scheme under its own content policy (src/desktop/artifacts.ts). It runs
   * once it scrolls into view, at most a few at a time, and is stopped if it stops answering.
   */
  let {
    source,
    title,
    chatId,
    onproblem,
  }: {
    source: string;
    title: string;
    chatId: string | null;
    /** A runtime error the demo reported, for the card to offer a fix. */
    onproblem?: (message: string) => void;
  } = $props();

  let host: HTMLDivElement;
  let frame = $state<HTMLIFrameElement>();
  /** null: not asked for yet; "": demos can't run here (the browser preview). */
  let url = $state<string | null>(null);
  let running = $state(false);
  let paused = $state(false);
  let silent = $state(false);
  let height = $state(160);
  let port: MessagePort | null = null;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let release: (() => void) | undefined;
  const resizes = rateLimit(10);

  async function start(): Promise<void> {
    if (running) return;
    url ??= await folio.demoUrl(source).catch(() => "");
    if (!url) return;
    silent = false;
    paused = false;
    running = true;
    release = claimLiveFrame(() => {
      stop();
      paused = true;
    });
  }

  function stop(): void {
    clearInterval(heartbeat);
    heartbeat = undefined;
    port?.close();
    port = null;
    running = false;
    release?.();
    release = undefined;
  }

  /** The frame loaded: hand it a private port; everything it says comes through that. */
  function connect(): void {
    const channel = new MessageChannel();
    port = channel.port1;
    let answered = Date.now();
    port.onmessage = (event) => {
      const message = frameMessage(event.data);
      if (!message) return;
      answered = Date.now();
      if (message.type === "resize" && resizes()) height = message.height;
      else if (message.type === "error") onproblem?.(message.message);
      else if (message.type === "ask" && chatId) folio.offerQuestion(chatId, message.text);
    };
    frame?.contentWindow?.postMessage({ type: "connect" }, "*", [channel.port2]);
    port.postMessage({ type: "theme", theme: folio.shownTheme });
    heartbeat = setInterval(() => {
      if (Date.now() - answered > FRAME_SILENCE) {
        stop();
        silent = true;
        return;
      }
      port?.postMessage({ type: "ping" });
    }, 1000);
  }

  $effect(() => {
    const theme = folio.shownTheme;
    port?.postMessage({ type: "theme", theme });
  });

  $effect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting) && !silent) void start();
      },
      { rootMargin: "200px" },
    );
    observer.observe(host);
    return () => {
      observer.disconnect();
      stop();
    };
  });
</script>

<div class="artifact" bind:this={host} style:min-height="{FRAME_MIN}px">
  {#if url === ""}
    <p class="artifact-note">Interactive demos run in the Folio app.</p>
  {:else if silent}
    <p class="artifact-note">
      This demo stopped responding.
      <button type="button" onclick={() => void start()}>Run it again</button>
    </p>
  {:else if running && url}
    <!-- Sealed: scripts only, no same-origin, no permissions. See src/desktop/artifacts.ts. -->
    <iframe
      bind:this={frame}
      src="{url}#theme={folio.shownTheme}"
      sandbox="allow-scripts"
      allow=""
      referrerpolicy="no-referrer"
      {title}
      style:height="{height}px"
      onload={connect}
    ></iframe>
  {:else if paused}
    <p class="artifact-note">
      Paused while other demos run.
      <button type="button" onclick={() => void start()}>Run it</button>
    </p>
  {/if}
</div>
