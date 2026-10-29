<script lang="ts">
  import { CalendarDate, type DateValue } from "@internationalized/date";
  import { CalendarDays, ChevronLeft, ChevronRight, X } from "@lucide/svelte";
  import { DatePicker } from "bits-ui";

  /**
   * A due date the student types or picks. Typing never saves on its own: a year typed digit
   * by digit passes through 0002 and 0020, so the date is saved when focus leaves the date (Tab
   * included), on Enter, or when a day is picked in the calendar. While the student is in the
   * date, and until what they saved comes back, the stored date never overwrites what they typed.
   */
  let {
    value,
    onchange,
    label = "Due date",
    overdue = false,
  }: {
    /** The saved date as an ISO instant, or null. */
    value: string | null;
    /** The new date as the end of that local day, or null when cleared. */
    onchange: (value: string | null) => void;
    label?: string;
    /** Shows the date in red, for work still to do whose date has passed. */
    overdue?: boolean;
  } = $props();

  const MIN = new CalendarDate(2000, 1, 1);
  const MAX = new CalendarDate(2100, 12, 31);
  const locale = typeof navigator === "undefined" ? "en" : navigator.language;

  let segments: HTMLSpanElement;
  let draft = $state<DateValue | undefined>();
  let open = $state(false);
  let editing = $state(false);
  /** The day last saved from here, until the stored date catches up with it. */
  let sent = $state<string | null | undefined>(undefined);

  // The saved date reaches the field only while the student is not in it, and not while their
  // own save is still on its way back.
  $effect(() => {
    const saved = dayOf(value);
    if (editing || open) return;
    if (sent !== undefined && (saved?.toString() ?? null) !== sent) return;
    sent = undefined;
    draft = saved;
  });

  function dayOf(iso: string | null): CalendarDate | undefined {
    if (!iso) return undefined;
    const date = new Date(iso);
    return new CalendarDate(
      date.getFullYear(),
      date.getMonth() + 1,
      date.getDate(),
    );
  }

  function commit(): void {
    const saved = dayOf(value);
    if (draft && (draft.compare(MIN) < 0 || draft.compare(MAX) > 0)) {
      draft = saved;
      return;
    }
    if (draft?.toString() === saved?.toString()) return;
    const day = draft?.toString() ?? null;
    sent = day;
    // A save that never lands (refused, or failed) gives the field back to the stored date.
    setTimeout(() => {
      if (sent === day) {
        sent = undefined;
        draft = dayOf(value);
      }
    }, 4_000);
    onchange(day ? new Date(`${day}T23:59:00`).toISOString() : null);
  }

  function clear(): void {
    draft = undefined;
    commit();
  }

  /** Focus left the date itself: to the calendar button, or anywhere else, it saves. */
  function left(): void {
    setTimeout(() => {
      if (open || segments.contains(document.activeElement)) return;
      editing = false;
      commit();
    });
  }
</script>

<DatePicker.Root
  bind:value={draft}
  bind:open
  {locale}
  minValue={MIN}
  maxValue={MAX}
  weekdayFormat="short"
  fixedWeeks
  onOpenChange={(next) => {
    if (!next) {
      editing = segments.contains(document.activeElement);
      commit();
    }
  }}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="group/date flex h-7 w-full min-w-0 items-center gap-0.5 rounded-md border border-transparent px-1 text-[12px] transition-colors hover:border-line focus-within:border-line-strong {overdue
      ? 'text-danger'
      : 'text-text-2'}"
    dir="ltr"
    onfocusout={left}
    onkeydown={(event) => {
      if (event.key === "Enter") commit();
      else if (event.key === "Escape" && !open) draft = dayOf(value);
    }}
  >
    <span
      bind:this={segments}
      class="flex min-w-0 flex-1"
      onfocusin={() => (editing = true)}
    >
    <DatePicker.Input
      aria-label={label}
      class="flex min-w-0 flex-1 items-center tabular-nums"
    >
      {#snippet children({ segments })}
        {#each segments as { part, value: text }, index (index)}
          <DatePicker.Segment
            {part}
            class="rounded-[3px] px-px outline-none focus:bg-selected focus:text-text data-[placeholder]:text-text-4 aria-[valuetext=Empty]:text-text-4"
          >
            {text}
          </DatePicker.Segment>
        {/each}
      {/snippet}
    </DatePicker.Input>
    </span>
    {#if draft}
      <!-- Out of the Tab order: Tab leaves the date and saves it; the pointer clears it. -->
      <button
        type="button"
        tabindex="-1"
        class="flex size-5 shrink-0 items-center justify-center rounded text-text-4 opacity-0 transition-opacity group-hover/date:opacity-100 hover:text-text"
        aria-label="Clear the due date"
        onclick={clear}
      >
        <X size={12} strokeWidth={2} />
      </button>
    {/if}
    <DatePicker.Trigger
      class="flex size-5 shrink-0 items-center justify-center rounded text-text-3 hover:text-text data-[state=open]:text-text"
      aria-label="Open the calendar"
    >
      <CalendarDays size={13} strokeWidth={1.75} />
    </DatePicker.Trigger>
  </div>
  <DatePicker.Portal>
    <DatePicker.Content
      sideOffset={6}
      align="start"
      class="z-50 animate-[folio-scale_140ms_var(--ease-out-quint)] rounded-xl border border-line-subtle bg-raised p-3 shadow-3 outline-none"
    >
      <DatePicker.Calendar>
        {#snippet children({ months, weekdays })}
          <DatePicker.Header class="mb-2 flex items-center justify-between">
            <DatePicker.PrevButton
              class="flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-hover"
            >
              <ChevronLeft
                size={15}
                strokeWidth={1.75}
                class="rtl:rotate-180"
              />
            </DatePicker.PrevButton>
            <DatePicker.Heading class="text-[13px] font-medium text-text" />
            <DatePicker.NextButton
              class="flex size-7 items-center justify-center rounded-md text-text-2 hover:bg-hover"
            >
              <ChevronRight
                size={15}
                strokeWidth={1.75}
                class="rtl:rotate-180"
              />
            </DatePicker.NextButton>
          </DatePicker.Header>
          {#each months as month (month.value.toString())}
            <DatePicker.Grid class="border-collapse select-none">
              <DatePicker.GridHead>
                <DatePicker.GridRow class="flex">
                  {#each weekdays as day (day)}
                    <DatePicker.HeadCell
                      class="w-8 pb-1 text-center text-[11px] font-normal text-text-3"
                    >
                      {day}
                    </DatePicker.HeadCell>
                  {/each}
                </DatePicker.GridRow>
              </DatePicker.GridHead>
              <DatePicker.GridBody>
                {#each month.weeks as dates, week (week)}
                  <DatePicker.GridRow class="flex">
                    {#each dates as date (date.toString())}
                      <DatePicker.Cell {date} month={month.value} class="p-0">
                        <DatePicker.Day
                          class="flex size-8 items-center justify-center rounded-md text-[12px] text-text tabular-nums hover:bg-hover data-[disabled]:pointer-events-none data-[disabled]:text-text-4 data-[outside-month]:text-text-4 data-[selected]:bg-ink data-[selected]:text-on-ink data-[today]:font-semibold"
                        />
                      </DatePicker.Cell>
                    {/each}
                  </DatePicker.GridRow>
                {/each}
              </DatePicker.GridBody>
            </DatePicker.Grid>
          {/each}
        {/snippet}
      </DatePicker.Calendar>
    </DatePicker.Content>
  </DatePicker.Portal>
</DatePicker.Root>
