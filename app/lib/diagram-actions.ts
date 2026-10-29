/**
 * The buttons on a drawn diagram (copy, save, enlarge), wherever the diagram appears: a reply, a
 * note's reading view or study notes. One listener for the page, so every place that shows
 * rendered Markdown gets them without wiring of its own.
 */

/** A diagram as Markdown, the way it was written, so it pastes into a note unchanged. */
export function diagramFence(source: string): string {
  return `\`\`\`mermaid\n${source}\n\`\`\``;
}

export function installDiagramActions(save: (name: string, svg: string) => Promise<unknown>): void {
  document.addEventListener("click", (event) => {
    const button = (event.target as Element | null)?.closest?.<HTMLButtonElement>(
      "button[data-diagram]",
    );
    const diagram = button?.closest<HTMLElement>(".diagram[data-source]");
    if (!button || !diagram) return;
    event.preventDefault();
    event.stopPropagation();
    const svg = diagram.querySelector("svg");
    const action = button.dataset.diagram;
    if (action === "copy")
      void navigator.clipboard
        .writeText(diagramFence(decodeURIComponent(diagram.dataset.source ?? "")))
        .then(() => flash(button, "Copied"));
    else if (action === "save" && svg) void save("diagram.svg", svg.outerHTML);
    else if (action === "enlarge" && svg) enlarge(svg);
  });
}

function flash(button: HTMLButtonElement, text: string): void {
  const label = button.textContent;
  button.textContent = text;
  setTimeout(() => (button.textContent = label), 1200);
}

/** The diagram at a larger size in a modal dialog; Escape or a click outside closes it. */
function enlarge(svg: SVGSVGElement): void {
  const dialog = document.createElement("dialog");
  dialog.className = "diagram-dialog";
  const frame = document.createElement("div");
  frame.className = "diagram-large";
  frame.append(svg.cloneNode(true));
  dialog.append(frame);
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
