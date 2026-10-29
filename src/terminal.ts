import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

export class TerminalInputCancelledError extends Error {
  constructor() {
    super("Terminal input cancelled.");
    this.name = "TerminalInputCancelledError";
  }
}

interface TerminalQuestionOptions {
  signal?: AbortSignal;
  onCancel?: () => void;
  input?: Readable;
  output?: Writable;
}

/** Settle pending input on EOF or Ctrl+C, and release readline on provider cancellation. */
export async function askTerminalQuestion(
  question: string,
  options: TerminalQuestionOptions = {},
): Promise<string> {
  options.signal?.throwIfAborted();
  const terminal = createInterface({
    input: options.input ?? process.stdin,
    output: options.output ?? process.stdout,
  });
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const cancel = () => {
    if (controller.signal.aborted) return;
    controller.abort(new TerminalInputCancelledError());
    options.onCancel?.();
  };
  terminal.once("SIGINT", cancel);
  terminal.once("close", cancel);
  try {
    return await terminal.question(question, { signal });
  } catch (error) {
    if (controller.signal.aborted) throw controller.signal.reason;
    throw error;
  } finally {
    terminal.removeListener("SIGINT", cancel);
    terminal.removeListener("close", cancel);
    terminal.close();
  }
}
