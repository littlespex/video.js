/**
 * A primary element for session tests: the clock and seek surface of an `HTMLMediaElement`, with `seeking` dispatched
 * synchronously on assignment so a test reads the outcome of a seek on the next line.
 */
export class FakeMedia extends EventTarget {
  #currentTime = 0;
  duration = Number.NaN;
  paused = true;
  ended = false;
  muted = false;
  currentSrc = 'https://example.com/stream.m3u8';
  seekableRanges: [number, number][] = [];

  get currentTime(): number {
    return this.#currentTime;
  }

  set currentTime(value: number) {
    this.#currentTime = value;
    this.dispatchEvent(new Event('seeking'));
  }

  get seekable(): TimeRanges {
    const ranges = this.seekableRanges;

    return {
      length: ranges.length,
      start: (index: number) => ranges[index]![0],
      end: (index: number) => ranges[index]![1],
    } as TimeRanges;
  }

  /** Move the clock forward as playback would, in steps, dispatching `timeupdate` at each. */
  advance(to: number, step = 0.25): void {
    while (this.#currentTime < to) {
      this.#currentTime = Math.min(to, this.#currentTime + step);
      this.dispatchEvent(new Event('timeupdate'));
    }
  }

  /** Jump the clock without a seek, so one `timeupdate` lands at `to`. */
  jump(to: number): void {
    this.#currentTime = to;
    this.dispatchEvent(new Event('timeupdate'));
  }

  /** Finish the seek the last `currentTime` assignment started. */
  settle(): void {
    this.dispatchEvent(new Event('seeked'));
  }

  /** A seek that did not come from the session, as native controls would issue it. */
  seek(to: number): void {
    this.currentTime = to;
    this.settle();
  }

  play(): void {
    this.paused = false;
    this.dispatchEvent(new Event('play'));
  }

  pause(): void {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.dispatchEvent(new Event('volumechange'));
  }

  asElement(): HTMLMediaElement {
    return this as unknown as HTMLMediaElement;
  }
}
