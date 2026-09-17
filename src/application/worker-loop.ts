import type { EventHandler } from "./event-ports.js";
import type { LocalEventWorker, WorkerResult } from "./event-ingestion.js";

export type WorkerLoopOptions = {
  pollMs: number;
  signal?: AbortSignal;
  onResult?: (result: WorkerResult) => void;
  onError?: (error: unknown) => void;
};

function waitForPoll(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function runWorkerLoop(worker: Pick<LocalEventWorker, "processNext">, handler: EventHandler, options: WorkerLoopOptions): Promise<void> {
  if (!Number.isInteger(options.pollMs) || options.pollMs < 0) throw new Error("pollMs deve ser um inteiro não negativo.");
  while (!options.signal?.aborted) {
    try {
      const result = await worker.processNext(handler);
      options.onResult?.(result);
      if (result.status === "IDLE" || result.status === "RETRY_SCHEDULED") await waitForPoll(options.pollMs, options.signal);
    } catch (error) {
      options.onError?.(error);
      await waitForPoll(options.pollMs, options.signal);
    }
  }
}
