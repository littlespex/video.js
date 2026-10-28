import type { StateAttrMap } from '../../types';
import type { TimelineMarkerGeometry } from './core';

/**
 * Data attributes a timeline marker reflects for styling.
 *
 * @internal
 */
export const TimeSliderMarkerDataAttrs = {
  /** The marker category, such as `ad` or `chapter`. */
  kind: 'data-kind',
  /** Present once the marker's break has played. */
  played: 'data-played',
  /** Whether the marker is drawn as content or highlighted. */
  style: 'data-style',
  /** Present when the marker has no span and draws as a point. */
  isPoint: 'data-point',
} as const satisfies StateAttrMap<Pick<TimelineMarkerGeometry, 'kind' | 'played' | 'style' | 'isPoint'>>;
