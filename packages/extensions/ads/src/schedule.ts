import type { Interstitial, InterstitialImpl, Slot } from './interstitial';
import { interstitialData } from './interstitial';

/**
 * A flat, ordered, read-only view of every region known to the session. Regions with a known `startTime` are sorted by
 * it; regions whose start is not yet known are appended in arrival order. Completed regions stay for history and for
 * `played` checks.
 *
 * @experimental
 */
export interface InterstitialSchedule {
  readonly items: ReadonlyArray<Interstitial>;
  /** The region the playhead is inside, or `null`. */
  readonly current: Interstitial | null;
  /** `current?.currentSlot`. */
  readonly currentSlot: Slot | null;
  /** The next scheduled region after the playhead. */
  readonly upcoming: Interstitial | null;

  getById(id: string): Interstitial | null;
  /** First region with `startTime > streamTime`. */
  nextAfter(streamTime: number): Interstitial | null;
  /** Last region with `startTime <= streamTime`. Used by snapback. */
  previousBefore(streamTime: number): Interstitial | null;
  /** Regions with `played === false` whose start lies in `(from, to]`. Used by jump enforcement. */
  unplayedBetween(fromStreamTime: number, toStreamTime: number): Interstitial[];
}

/** @internal */
export class ScheduleImpl implements InterstitialSchedule {
  readonly #items: InterstitialImpl[] = [];
  readonly #byId = new Map<string, InterstitialImpl>();
  readonly #streamTime: () => number;
  #current: InterstitialImpl | null = null;

  constructor(streamTime: () => number) {
    this.#streamTime = streamTime;
  }

  get items(): ReadonlyArray<InterstitialImpl> {
    return this.#items;
  }

  get current(): InterstitialImpl | null {
    return this.#current;
  }

  get currentSlot(): Slot | null {
    return this.#current?.currentSlot ?? null;
  }

  get upcoming(): InterstitialImpl | null {
    return this.nextAfter(this.#streamTime());
  }

  getById(id: string): InterstitialImpl | null {
    return this.#byId.get(id) ?? null;
  }

  nextAfter(streamTime: number): InterstitialImpl | null {
    return this.#items.find((item) => item.startTime !== null && item.startTime > streamTime) ?? null;
  }

  previousBefore(streamTime: number): InterstitialImpl | null {
    let found: InterstitialImpl | null = null;

    for (const item of this.#items) {
      if (item.startTime === null || item.startTime > streamTime) break;

      found = item;
    }

    return found;
  }

  unplayedBetween(fromStreamTime: number, toStreamTime: number): InterstitialImpl[] {
    return this.#items.filter(
      (item) =>
        !item.played && item.startTime !== null && item.startTime > fromStreamTime && item.startTime <= toStreamTime
    );
  }

  // ----------------------------------------
  // Session-only mutation
  // ----------------------------------------

  has(id: string): boolean {
    return this.#byId.has(id);
  }

  add(item: InterstitialImpl): void {
    this.#byId.set(item.id, item);
    this.#items.push(item);
    this.sort();
  }

  remove(item: InterstitialImpl): boolean {
    const index = this.#items.indexOf(item);
    if (index < 0) return false;

    this.#items.splice(index, 1);
    this.#byId.delete(item.id);

    if (this.#current === item) this.#current = null;

    return true;
  }

  /** Re-sort after a `startTime` change. Known starts first by time, then unknown starts in arrival order. */
  sort(): void {
    this.#items.sort((a, b) => {
      if (a.startTime === null || b.startTime === null) {
        if (a.startTime === b.startTime) return interstitialData(a).order - interstitialData(b).order;

        return a.startTime === null ? 1 : -1;
      }

      return a.startTime - b.startTime || interstitialData(a).order - interstitialData(b).order;
    });
  }

  setCurrent(item: InterstitialImpl | null): void {
    this.#current = item;
  }

  /** The region whose span contains `streamTime`, or `null`. */
  findAt(streamTime: number): InterstitialImpl | null {
    for (let index = 0; index < this.#items.length; index++) {
      const item = this.#items[index]!;
      if (item.startTime === null) break;

      if (item.startTime <= streamTime && streamTime < this.effectiveEnd(index)) return item;
    }

    return null;
  }

  /**
   * Where a region stops occupying the timeline: its end when the duration is known, the planned end when only that is
   * announced, and otherwise the next known region start, so an unresolved live break ends when the next one begins.
   */
  effectiveEnd(index: number): number {
    const item = this.#items[index]!;
    if (item.endTime !== null) return item.endTime;

    const { startTime, plannedDuration } = item;
    if (startTime !== null && plannedDuration !== null) return startTime + plannedDuration;

    const next = this.#items[index + 1];

    return next?.startTime ?? Number.POSITIVE_INFINITY;
  }
}
