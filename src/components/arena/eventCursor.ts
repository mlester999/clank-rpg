/**
 * Which replay events are due to be shown, each exactly once.
 *
 * The cursor only moves forward. The viewer's estimate of the server clock is refined by every poll, so the combat
 * clock can step BACKWARD by a few milliseconds between frames; that must never re-fire events that were already
 * shown (an elimination would appear in the kill feed twice). Starting over is explicit: `reset()`, used when a
 * different battle or a different replay is installed.
 */
export interface CursorEvent {
  /** Tick the event happened on. */
  0: number;
}

export class EventCursor {
  private idx = 0;
  private lastMs = 0;

  reset(): void {
    this.idx = 0;
    this.lastMs = 0;
  }

  /**
   * Events whose time has come, in order. After a long gap (a tab that was asleep, or joining mid-fight) events older
   * than `staleMs` before now are skipped, not replayed.
   */
  take<E extends CursorEvent>(events: readonly E[], tickMs: number, combatMs: number, opts: { gapMs?: number; staleMs?: number } = {}): E[] {
    const gapMs = opts.gapMs ?? 900;
    const staleMs = opts.staleMs ?? 700;
    if (combatMs - this.lastMs > gapMs) {
      while (this.idx < events.length && (events[this.idx] as E)[0] * tickMs < combatMs - staleMs) this.idx++;
    }
    this.lastMs = Math.max(this.lastMs, combatMs);
    const due: E[] = [];
    while (this.idx < events.length) {
      const ev = events[this.idx] as E;
      if (ev[0] * tickMs > combatMs) break;
      this.idx++;
      due.push(ev);
    }
    return due;
  }
}

/**
 * Kill-feed identity: a hero can be eliminated once per battle, so `battle:victim` names an elimination for good.
 * Whatever re-delivers the event (a restarted cursor, a remounted renderer, a re-fetched replay), the feed shows it once;
 * two different eliminations — even of heroes with the same name — never share a key.
 */
export class EliminationLog {
  private readonly seen = new Set<string>();

  /** The stable key if this is the first time the elimination is seen, otherwise null. */
  first(battleId: string, victimSlot: number): string | null {
    const key = `${battleId}:${victimSlot}`;
    if (this.seen.has(key)) return null;
    this.seen.add(key);
    if (this.seen.size > 64) this.seen.delete(this.seen.values().next().value as string);
    return key;
  }
}
