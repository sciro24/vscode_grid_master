/**
 * Unit tests for chunk timeout/retry/cleanup logic introduced in Phase 1.
 * These tests verify the Map bookkeeping in isolation without instantiating
 * GridStore (which requires Svelte runes / browser environment).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal stand-in that mirrors the _pendingChunks / _pendingChunkTimers /
// _chunkRetryCount maps and the timeout logic from _requestChunk.
// ---------------------------------------------------------------------------

interface PendingEntry { startRow: number; endRow: number }

function makeChunkManager(onError: (msg: string) => void) {
  const pendingChunks = new Map<string, number>();           // requestId → startRow
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const retryCount   = new Map<string, number>();
  const posted: string[] = [];                              // requestIds posted to worker

  function requestChunk(startRow: number, endRow: number, retryId?: string): void {
    const alreadyPending = [...pendingChunks.values()].includes(startRow);
    if (alreadyPending && !retryId) return;

    const requestId = retryId ?? `chunk-${startRow}-${Date.now()}`;
    pendingChunks.set(requestId, startRow);
    posted.push(requestId);

    const timer = setTimeout(() => {
      pendingChunks.delete(requestId);
      pendingTimers.delete(requestId);
      const retries = retryCount.get(requestId) ?? 0;
      retryCount.delete(requestId);
      if (retries === 0) {
        const retryRid = `${requestId}-retry`;
        retryCount.set(retryRid, 1);
        requestChunk(startRow, endRow, retryRid);
      } else {
        onError(`Chunk request timed out (startRow=${startRow})`);
      }
    }, 15_000);
    pendingTimers.set(requestId, timer);
  }

  function receiveChunk(requestId: string, startRow: number): void {
    pendingChunks.delete(requestId);
    const t = pendingTimers.get(requestId);
    if (t !== undefined) { clearTimeout(t); pendingTimers.delete(requestId); }
    retryCount.delete(requestId);
  }

  function handleError(): void {
    for (const [rid] of pendingChunks) {
      const t = pendingTimers.get(rid);
      if (t !== undefined) { clearTimeout(t); pendingTimers.delete(rid); }
      retryCount.delete(rid);
    }
    pendingChunks.clear();
  }

  return { pendingChunks, pendingTimers, retryCount, posted, requestChunk, receiveChunk, handleError };
}

// ---------------------------------------------------------------------------

describe('chunk timeout + retry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('worker never responds → first timeout triggers retry, second timeout surfaces error', () => {
    const errors: string[] = [];
    const mgr = makeChunkManager(e => errors.push(e));

    mgr.requestChunk(0, 100);
    expect(mgr.pendingChunks.size).toBe(1);
    expect(mgr.posted).toHaveLength(1);

    // First timeout: should retry (pendingChunks still has the retry entry).
    vi.advanceTimersByTime(15_000);
    expect(mgr.pendingChunks.size).toBe(1);           // retry in flight
    expect(mgr.posted).toHaveLength(2);               // retry was posted
    expect(errors).toHaveLength(0);

    // Second timeout: should surface error, pendingChunks empty.
    vi.advanceTimersByTime(15_000);
    expect(mgr.pendingChunks.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/startRow=0/);
  });

  it('chunk received before timeout → timer cleared, no error', () => {
    const errors: string[] = [];
    const mgr = makeChunkManager(e => errors.push(e));

    mgr.requestChunk(0, 100);
    const rid = mgr.posted[0];
    mgr.receiveChunk(rid, 0);

    vi.advanceTimersByTime(30_000);
    expect(mgr.pendingChunks.size).toBe(0);
    expect(errors).toHaveLength(0);
  });

  it('deduplicates: second requestChunk for same startRow is a no-op', () => {
    const mgr = makeChunkManager(() => {});
    mgr.requestChunk(0, 100);
    mgr.requestChunk(0, 100);
    expect(mgr.posted).toHaveLength(1);
    expect(mgr.pendingChunks.size).toBe(1);
  });
});

describe('ERROR clears all pending', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ERROR mid-flight → all pending chunks cleared, all timers cancelled', () => {
    const errors: string[] = [];
    const mgr = makeChunkManager(e => errors.push(e));

    mgr.requestChunk(0,   100);
    mgr.requestChunk(100, 200);
    mgr.requestChunk(200, 300);
    expect(mgr.pendingChunks.size).toBe(3);
    expect(mgr.pendingTimers.size).toBe(3);

    mgr.handleError();

    expect(mgr.pendingChunks.size).toBe(0);
    expect(mgr.pendingTimers.size).toBe(0);

    // Advance past all timers — no spurious errors should fire.
    vi.advanceTimersByTime(60_000);
    expect(errors).toHaveLength(0);
  });
});
