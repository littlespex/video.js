import { SliderDataAttrs, type SliderState, type TimelineMarker } from '@videojs/core';
import type { AnyPlayerStore } from '@videojs/core/dom';
import { ContextProvider } from '@videojs/element/context';
import { createStore, flush } from '@videojs/store';
import { afterEach, describe, expect, it } from 'vite-plus/test';

import { playerContext } from '../../../player/context';
import { sliderContext, type SliderContextValue } from '../../slider/context';
import { UIElement } from '../../ui-element';
import { TimeSliderMarkersElement } from '../markers';

let tagCounter = 0;

function createElement<Element extends HTMLElement>(Base: abstract new () => Element): Element {
  const tag = `test-markers-${tagCounter++}`;

  customElements.define(tag, class extends (Base as unknown as typeof HTMLElement) {});
  return document.createElement(tag) as Element;
}

const SLIDER_STATE: SliderState = {
  value: 0,
  fillPercent: 0,
  pointerPercent: 0,
  dragging: false,
  pointing: false,
  interactive: false,
  orientation: 'horizontal',
  disabled: false,
  thumbAlignment: 'center',
};

function sliderValue(): SliderContextValue {
  return {
    state: SLIDER_STATE,
    stateAttrMap: SliderDataAttrs,
    pointerValue: 0,
    thumbAttrs: {},
    thumbProps: {} as SliderContextValue['thumbProps'],
  };
}

/** Provides both the player store (duration + markers) and the slider context the markers element consumes. */
class TestMarkersProvider extends UIElement {
  readonly store = createStore<unknown>()({
    name: 'markers',
    state: () => ({
      currentTime: 0,
      duration: 100,
      seeking: false,
      seek: () => {},
      timelineMarkers: [] as readonly TimelineMarker[],
    }),
  }) as unknown as AnyPlayerStore;

  readonly playerProvider = new ContextProvider(this, { context: playerContext, initialValue: this.store });
  readonly sliderProvider = new ContextProvider(this, { context: sliderContext, initialValue: sliderValue() });

  setMarkers(markers: readonly TimelineMarker[]): void {
    (this.store as unknown as { $state: { patch: (p: object) => void } }).$state.patch({ timelineMarkers: markers });
  }
}

customElements.define('test-markers-provider', TestMarkersProvider);

function marker(overrides: Partial<TimelineMarker> = {}): TimelineMarker {
  return { id: 'a', time: 25, duration: 10, kind: 'ad', label: null, played: false, style: 'highlight', ...overrides };
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('TimeSliderMarkersElement', () => {
  it('is decorative', async () => {
    const provider = new TestMarkersProvider();
    const markers = createElement(TimeSliderMarkersElement);

    provider.appendChild(markers);
    document.body.appendChild(provider);
    await markers.updateComplete;

    expect(markers.getAttribute('aria-hidden')).toBe('true');
  });

  it('positions one clone per marker by content time and span', async () => {
    const provider = new TestMarkersProvider();

    provider.setMarkers([marker({ id: 'pre', time: 0, duration: 5 }), marker({ id: 'mid', time: 25, duration: 10 })]);

    const markers = createElement(TimeSliderMarkersElement);
    const template = document.createElement('template');

    template.innerHTML = '<div class="marker"></div>';
    markers.appendChild(template);
    provider.appendChild(markers);
    document.body.appendChild(provider);
    await markers.updateComplete;

    const rendered = markers.querySelectorAll<HTMLElement>('.marker');

    expect(rendered).toHaveLength(2);
    expect(rendered[0]!.style.getPropertyValue('--media-slider-marker-start')).toBe('0%');
    expect(rendered[0]!.style.getPropertyValue('--media-slider-marker-width')).toBe('5%');
    expect(rendered[1]!.style.getPropertyValue('--media-slider-marker-start')).toBe('25%');
    expect(rendered[1]!.style.getPropertyValue('--media-slider-marker-width')).toBe('10%');
    expect(rendered[1]!.getAttribute('data-kind')).toBe('ad');
    expect(rendered[1]!.getAttribute('data-style')).toBe('highlight');
  });

  it('draws a point when the marker has no span', async () => {
    const provider = new TestMarkersProvider();

    provider.setMarkers([marker({ duration: null })]);

    const markers = createElement(TimeSliderMarkersElement);
    const template = document.createElement('template');

    template.innerHTML = '<div class="marker"></div>';
    markers.appendChild(template);
    provider.appendChild(markers);
    document.body.appendChild(provider);
    await markers.updateComplete;

    const rendered = markers.querySelector<HTMLElement>('.marker')!;

    expect(rendered.style.getPropertyValue('--media-slider-marker-width')).toBe('0%');
    expect(rendered.getAttribute('data-point')).toBe('');
  });

  it('adds and removes clones as markers change', async () => {
    const provider = new TestMarkersProvider();
    const markers = createElement(TimeSliderMarkersElement);
    const template = document.createElement('template');

    template.innerHTML = '<div class="marker"></div>';
    markers.appendChild(template);
    provider.appendChild(markers);
    document.body.appendChild(provider);
    await markers.updateComplete;

    expect(markers.querySelectorAll('.marker')).toHaveLength(0);

    provider.setMarkers([marker({ id: 'one' }), marker({ id: 'two', time: 50 })]);
    flush();
    await markers.updateComplete;
    expect(markers.querySelectorAll('.marker')).toHaveLength(2);

    provider.setMarkers([marker({ id: 'one' })]);
    flush();
    await markers.updateComplete;
    expect(markers.querySelectorAll('.marker')).toHaveLength(1);
  });

  it('reflects the played flag onto the clone', async () => {
    const provider = new TestMarkersProvider();

    provider.setMarkers([marker({ played: true })]);

    const markers = createElement(TimeSliderMarkersElement);
    const template = document.createElement('template');

    template.innerHTML = '<div class="marker"></div>';
    markers.appendChild(template);
    provider.appendChild(markers);
    document.body.appendChild(provider);
    await markers.updateComplete;

    expect(markers.querySelector<HTMLElement>('.marker')!.getAttribute('data-played')).toBe('');
  });
});
