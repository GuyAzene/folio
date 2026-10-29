import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { askTerminalQuestion, TerminalInputCancelledError } from "../src/terminal.ts";

function streams() {
  return { input: new PassThrough(), output: new PassThrough() };
}

describe("terminal question lifecycle", () => {
  it("returns an answer and leaves the input available for the next question", async () => {
    const io = streams();
    const onCancel = vi.fn();
    const answer = askTerminalQuestion("First > ", { ...io, onCancel });
    io.input.write("one\n");
    await expect(answer).resolves.toBe("one");
    const next = askTerminalQuestion("Second > ", { ...io, onCancel });
    io.input.write("two\n");
    await expect(next).resolves.toBe("two");
    expect(onCancel).not.toHaveBeenCalled();
    io.input.destroy();
    io.output.destroy();
  });

  it("settles pending input and cancels the whole interaction on EOF", async () => {
    const io = streams();
    const onCancel = vi.fn();
    const answer = askTerminalQuestion("Input > ", { ...io, onCancel });
    const rejected = expect(answer).rejects.toBeInstanceOf(TerminalInputCancelledError);
    io.input.end();
    await rejected;
    expect(onCancel).toHaveBeenCalledOnce();
    io.output.destroy();
  });

  it("closes a provider-cancelled prompt without cancelling the whole interaction", async () => {
    const io = streams();
    const controller = new AbortController();
    const onCancel = vi.fn();
    const answer = askTerminalQuestion("Input > ", {
      ...io,
      signal: controller.signal,
      onCancel,
    });
    const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
    controller.abort();
    await rejected;
    expect(onCancel).not.toHaveBeenCalled();
    expect(io.input.listenerCount("data")).toBe(0);
    io.input.destroy();
    io.output.destroy();
  });

  it("rejects an already-cancelled prompt without attaching input listeners", async () => {
    const io = streams();
    await expect(
      askTerminalQuestion("Input > ", { ...io, signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(io.input.listenerCount("data")).toBe(0);
    io.input.destroy();
    io.output.destroy();
  });
});
