/**
 * CSS geometry for one timeline marker.
 *
 * @internal
 */
export const TimeSliderMarkerCSSVars = {
  /** Marker start as a percentage of the slider domain. */
  start: '--media-slider-marker-start',
  /** Marker width as a percentage of the slider domain. `0%` for a point. */
  width: '--media-slider-marker-width',
} as const;
