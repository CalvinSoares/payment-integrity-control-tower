import { describe, expect, it } from "vitest";
import { runWorkerLoop } from "../src/application/worker-loop.js";

describe("local worker loop", () => {
  it("processes a result and stops gracefully when aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const results: string[] = [];
    const worker = {
      processNext: async () => {
        calls += 1;
        controller.abort();
        return { status: "APPLIED" as const, eventId: "evt_loop" };
      },
    };

    await runWorkerLoop(worker, async () => undefined, {
      pollMs: 0,
      signal: controller.signal,
      onResult: (result) => results.push(result.status),
    });

    expect(calls).toBe(1);
    expect(results).toEqual(["APPLIED"]);
  });
});
