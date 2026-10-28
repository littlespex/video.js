import type { TimeRangeLike } from '@videojs/media';

import type { Interstitial } from './interstitial';

/**
 * Stream time, content time and the conversions between them.
 *
 * Stream time is `primaryElement.currentTime` and includes stitched interstitials. Content time is stream time with the
 * durations of completed or active `stitched` regions removed, which is what the viewer thinks of as position in the
 * program. Stitched durations are removed on VOD only: on live streams content time equals stream time, because the
 * viewer scrubs the DVR window as the stream presents it and there is no program duration to preserve.
 *
 * @internal
 */
export interface TimeMapping {
  readonly streamTime: number;
  readonly contentTime: number;
  /** Program duration without stitched ad time. `null` on live, and until the primary duration is known. */
  readonly contentDuration: number | null;
  contentTimeForStreamTime(streamTime: number): number;
  streamTimeForContentTime(contentTime: number): number;
  /** Seekable ranges in content time. */
  readonly contentSeekable: TimeRangeLike;
  /** Buffered ranges in content time. */
  readonly contentBuffered: TimeRangeLike;
  /** Combined timeline for UI during `inserted` or `replaced` regions: primary plus the active interstitial. */
  readonly integrated: {
    readonly currentTime: number;
    readonly duration: number | null;
    readonly seekableStart: number;
    readonly seekableEnd: number;
  };
}

/** @internal */
export interface TimeMappingSource {
  readonly primary: HTMLMediaElement;
  /** Stitched regions with a known start, in start order. */
  stitched(): ReadonlyArray<Interstitial>;
  live(): boolean;
}

function regionDuration(region: Interstitial): number {
  return region.duration ?? region.plannedDuration ?? 0;
}

function createRanges(ranges: readonly [number, number][]): TimeRangeLike {
  return {
    length: ranges.length,
    start: (index: number) => ranges[index]![0],
    end: (index: number) => ranges[index]![1],
  };
}

/** @internal */
export function createTimeMapping(source: TimeMappingSource): TimeMapping {
  const contentTimeForStreamTime = (streamTime: number): number => {
    if (source.live()) return streamTime;

    let removed = 0;

    for (const region of source.stitched()) {
      const startTime = region.startTime!;
      if (startTime >= streamTime) break;

      // Inside a region content time stands still at the region's content start.
      removed += Math.min(regionDuration(region), streamTime - startTime);
    }

    return streamTime - removed;
  };

  const streamTimeForContentTime = (contentTime: number): number => {
    if (source.live()) return contentTime;

    let offset = 0;

    for (const region of source.stitched()) {
      const contentStart = region.startTime! - offset;
      // Strict, so the content time at which a break begins maps to the break, not past it.
      if (contentTime <= contentStart) break;

      offset += regionDuration(region);
    }

    return contentTime + offset;
  };

  const toContentRanges = (ranges: TimeRangeLike): TimeRangeLike => {
    const mapped: [number, number][] = [];

    for (let index = 0; index < ranges.length; index++) {
      mapped.push([contentTimeForStreamTime(ranges.start(index)), contentTimeForStreamTime(ranges.end(index))]);
    }

    return createRanges(mapped);
  };

  const mapping: TimeMapping = {
    get streamTime() {
      return source.primary.currentTime;
    },
    get contentTime() {
      return contentTimeForStreamTime(source.primary.currentTime);
    },
    get contentDuration() {
      const { duration } = source.primary;
      if (source.live() || !Number.isFinite(duration)) return null;

      let removed = 0;

      for (const region of source.stitched()) {
        if (region.startTime! >= duration) break;

        removed += Math.min(regionDuration(region), duration - region.startTime!);
      }

      return Math.max(0, duration - removed);
    },
    contentTimeForStreamTime,
    streamTimeForContentTime,
    get contentSeekable() {
      return toContentRanges(source.primary.seekable);
    },
    get contentBuffered() {
      return toContentRanges(source.primary.buffered);
    },
    get integrated() {
      const { primary } = source;
      const { seekable, duration } = primary;
      const last = seekable.length - 1;

      return {
        currentTime: primary.currentTime,
        duration: Number.isFinite(duration) ? duration : null,
        seekableStart: last >= 0 ? seekable.start(0) : 0,
        seekableEnd: last >= 0 ? seekable.end(last) : Number.isFinite(duration) ? duration : 0,
      };
    },
  };

  return mapping;
}
