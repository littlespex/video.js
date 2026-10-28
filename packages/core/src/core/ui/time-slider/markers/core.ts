import { clamp } from '@videojs/utils/number';

/**
 * A point or span drawn on the time slider, in content time. The ads feature contributes one per ad break; other
 * features (chapters, cuepoints) may contribute to the same array later, which is why `kind` is an open union.
 *
 * @internal
 */
export interface TimelineMarker {
  /** Stable identity used by platform renderers. */
  id: string;
  /** Content time of the marker, in seconds. */
  time: number;
  /** Span length in seconds. `null` or `0` renders as a point. */
  duration: number | null;
  kind: 'ad' | 'content' | 'chapter' | 'cuepoint' | (string & {});
  label: string | null;
  played: boolean;
  style: 'highlight' | 'primary';
}

/**
 * Generic timeline-marker state contributed to the player store. A feature adds its markers to `timelineMarkers`; the
 * time slider's markers part renders them.
 *
 * @internal
 */
export interface TimelineMarkersState {
  timelineMarkers: ReadonlyArray<TimelineMarker>;
}

/**
 * A marker positioned against the slider domain.
 *
 * @internal
 */
export interface TimelineMarkerGeometry extends TimelineMarker {
  /** Stable key for the renderer; the marker id. */
  key: string;
  /** Start as a percentage of the slider domain. */
  startPercent: `${number}%`;
  /** Width as a percentage of the slider domain. `0%` for a point. */
  widthPercent: `${number}%`;
  /** Whether the marker has no span and draws as a single point. */
  isPoint: boolean;
}

/**
 * Positions timeline markers along the slider domain `[0, duration]`.
 *
 * @internal
 */
export class TimeSliderMarkersCore {
  getGeometry(markers: readonly TimelineMarker[], duration: number): TimelineMarkerGeometry[] {
    if (!Number.isFinite(duration) || duration <= 0) return [];

    const geometry: TimelineMarkerGeometry[] = [];

    for (const marker of markers) {
      if (!Number.isFinite(marker.time) || marker.time < 0 || marker.time > duration) continue;

      const start = clamp(marker.time / duration, 0, 1);
      const span = marker.duration && marker.duration > 0 ? clamp(marker.duration / duration, 0, 1 - start) : 0;

      geometry.push({
        ...marker,
        key: marker.id,
        startPercent: `${start * 100}%`,
        widthPercent: `${span * 100}%`,
        isPoint: span === 0,
      });
    }

    return geometry;
  }
}
