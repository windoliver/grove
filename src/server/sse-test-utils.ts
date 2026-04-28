/**
 * Test-only utilities for draining text/event-stream responses into structured
 * events. Used by watch.integration.test.ts and sibling acceptance tests (#292).
 */

export interface SseEvent {
  readonly id: string;
  readonly event: string;
  readonly data: unknown;
}

/**
 * Drain an SSE response body until either `stopAfter` events have been seen
 * or `timeoutMs` has elapsed. Cancels the underlying reader on return.
 */
export async function readSseEvents(
  res: Response,
  stopAfter: number,
  timeoutMs = 2_000,
): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  const body = res.body;
  if (!body) return events;
  const reader = body.getReader();
  type ReadResult = Awaited<ReturnType<typeof reader.read>>;
  const decoder = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + timeoutMs;

  while (events.length < stopAfter && Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    let result: ReadResult;
    try {
      result = await Promise.race([
        reader.read(),
        new Promise<ReadResult>((resolve) =>
          setTimeout(
            () => resolve({ value: undefined, done: false } as ReadResult),
            remainingMs,
          ),
        ),
      ]);
    } catch {
      break;
    }
    if (result.done) break;
    if (result.value === undefined) continue; // timed out this read
    buf += decoder.decode(result.value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const id = /^id: (.*)$/m.exec(block)?.[1] ?? "";
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "";
      const dataLine = /^data: (.*)$/m.exec(block)?.[1] ?? "null";
      let data: unknown = null;
      try {
        data = JSON.parse(dataLine);
      } catch {
        data = dataLine;
      }
      events.push({ id, event, data });
    }
  }
  try {
    await reader.cancel();
  } catch {
    /* already cancelled */
  }
  return events;
}
