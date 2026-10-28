import { describe, expect, it } from 'vite-plus/test';

import { type TimelineMarker, TimeSliderMarkersCore } from '../core';

function marker(id: string, time: number, duration: number | null): TimelineMarker {
  return { id, time, duration, kind: 'ad', label: null, played: false, style: 'highlight' };
}

describe('TimeSliderMarkersCore', () => {
  const core = new TimeSliderMarkersCore();

  it('positions spans and points against the duration', () => {
    expect(core.getGeometry([marker('span', 25, 25), marker('point', 50, null), marker('zero', 75, 0)], 100)).toEqual([
      expect.objectContaining({ key: 'span', startPercent: '25%', widthPercent: '25%', isPoint: false }),
      expect.objectContaining({ key: 'point', startPercent: '50%', widthPercent: '0%', isPoint: true }),
      expect.objectContaining({ key: 'zero', startPercent: '75%', widthPercent: '0%', isPoint: true }),
    ]);
  });

  it('clips a span at the end of the slider and drops markers outside it', () => {
    const geometry = core.getGeometry([marker('late', 50, 100), marker('past', 120, 10), marker('neg', -1, 10)], 100);

    expect(geometry.map(({ key }) => key)).toEqual(['late']);
    expect(geometry[0]!.widthPercent).toBe('50%');
  });

  it('renders nothing without a finite positive duration', () => {
    expect(core.getGeometry([marker('a', 10, 10)], 0)).toEqual([]);
    expect(core.getGeometry([marker('a', 10, 10)], Number.POSITIVE_INFINITY)).toEqual([]);
  });
});
