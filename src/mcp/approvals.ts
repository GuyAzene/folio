import { randomUUID } from "node:crypto";

/**
 * Calls to the student's services that wait for them: Allow once, Always allow or Deny. A
 * waiting call holds its reply open until the student answers or stops the reply. Nothing here
 * is saved: after a restart, the reply is interrupted and the call never runs.
 */

export type Decision = "once" | "always" | "deny";

export interface ApprovalRequest {
  id: string;
  chatId: string;
  /** The tool call's ID in the reply. */
  callId: string;
  serverId: string;
  label: string;
  tool: string;
  description: string;
  /** What the server says about its tool; shown, never trusted. */
  hints: { readOnly?: boolean; destructive?: boolean; openWorld?: boolean };
  /** Exactly what Folio will send. */
  args: Record<string, unknown>;
  at: string;
}

export class ApprovalStopped extends Error {
  constructor() {
    super("The reply stopped before the student answered; nothing was sent.");
  }
}

export class Approvals {
  readonly #waiting = new Map<
    string,
    { request: ApprovalRequest; answer: (decision: Decision) => void }
  >();
  readonly #changed: (chatId: string) => void;

  constructor(changed: (chatId: string) => void) {
    this.#changed = changed;
  }

  /** Waits for the student's answer; rejects with ApprovalStopped when `signal` stops the reply. */
  ask(request: Omit<ApprovalRequest, "id" | "at">, signal?: AbortSignal): Promise<Decision> {
    if (signal?.aborted) return Promise.reject(new ApprovalStopped());
    const id = randomUUID();
    const full: ApprovalRequest = { ...request, id, at: new Date().toISOString() };
    return new Promise<Decision>((resolve, reject) => {
      const stop = () => {
        if (!this.#waiting.delete(id)) return;
        this.#changed(full.chatId);
        reject(new ApprovalStopped());
      };
      signal?.addEventListener("abort", stop, { once: true });
      this.#waiting.set(id, {
        request: full,
        answer: (decision) => {
          signal?.removeEventListener("abort", stop);
          resolve(decision);
        },
      });
      this.#changed(full.chatId);
    });
  }

  /** The student's answer; the first one counts. */
  answer(id: string, decision: Decision): ApprovalRequest {
    if (!["once", "always", "deny"].includes(decision)) throw new Error("Unknown answer.");
    const waiting = this.#waiting.get(id);
    if (!waiting) throw new Error("That request is no longer waiting.");
    this.#waiting.delete(id);
    waiting.answer(decision);
    this.#changed(waiting.request.chatId);
    return structuredClone(waiting.request);
  }

  /** What waits for the student, oldest first; in one chat when `chatId` is given. */
  list(chatId?: string): ApprovalRequest[] {
    return [...this.#waiting.values()]
      .map((waiting) => waiting.request)
      .filter((request) => chatId === undefined || request.chatId === chatId)
      .map((request) => structuredClone(request));
  }
}
