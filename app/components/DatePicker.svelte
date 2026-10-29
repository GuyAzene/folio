<script lang="ts">
  import { CalendarDate, type DateValue } from "@internationalized/date";
  import { CalendarDays, ChevronLeft, ChevronRight, X } from "@lucide/svelte";
  import { DatePicker } from "bits-ui";

  /**
   * A due date the student types or picks. Typing never saves on its own: a year typed digit
   * by digit passes through 0002 and 0020, so the date is saved when the field loses focus, on
   * Enter, or when a day is picked in the calendar. While the student is in the field, the saved
   * date is never written back over what they are typing.
   */
  let {
    value,
    onchange,
    label = "Due date",
  }: {
    /** The saved date as an ISO instant, or null. */
    value: string | null;
    /** The new date as the end of that local day, or null when cleared. */
    onchange: (value: string | null) => void;
    label?: string;
  } = $props();

  const MIN = new CalendarDate(2000, 1, 1);
  const MAX = new CalendarDate(2100, 12, 31);
  const locale = typeof navigator === "undefined" ? "en" : navigator.language;

  let field: HTMLDivElement;
  let draft = $state<DateValue | undefined>();
  let open = $state(false);
  let editing = $state(false);

  // The saved date reaches the field only while the student is not in it.
  $effect(() => {
    const saved = dayOf(value);
    if (!editing && !open) draft = saved;
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
    onchange(
      draft ? new Date(`${draft.toString()}T23:59:00`).toISOString() : null,
    );
  }

  function clear(): void {
    draft = undefined;
    commit();
  }

  function left(event: FocusEvent): void {
    // Focus moving into the calendar is still editing; the calendar commits when it closes.
    setTimeout(() => {
      if (open || field.contains(document.activeElement)) return;
      editing = false;
      commit();
    });
    void event;
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
      editing = field.contains(document.activeElement);
      commit();
    }
  }}
>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={field}
    class="group/date flex h-7 w-full min-w-0 items-center gap-1 rounded-md border border-transparent px-1 text-[12px] text-text-2 transition-colors hover:border-line focus-within:border-line-strong"
    dir="ltr"
    onfocusin={() => (editing = true)}
    onfocusout={left}
    onkeydown={(event) => {
      if (event.key === "Enter") commit();
      else if (event.key === "Escape" && !open) draft = dayOf(value);
    }}
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
    {#if draft}
      <button
        type="button"
        class="flex size-5 shrink-0 items-center justify-center rounded text-text-4 opacity-0 transition-opacity group-hover/date:opacity-100 hover:text-text focus-visible:opacity-100"
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
