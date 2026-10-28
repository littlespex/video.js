import { describe, expect, it } from 'vite-plus/test';

import { findMetadataTrack, groupDateRangeCues } from '../metadata-track';

describe('groupDateRangeCues', () => {
  it('reassembles the attribute cues of one date range into its span and attribute map', () => {
    const [group] = groupDateRangeCues([
      { id: 'break', startTime: 12, endTime: 30, value: { key: 'X-RESTRICT', data: 'JUMP' } },
      { id: 'break', startTime: 10, endTime: 20, value: { key: 'X-AD-CREATIVE-SIGNALING', data: 'e30=' } },
      { id: 'other', startTime: 50, endTime: 60, text: '{"key":"X-TITLE","data":"Chapter"}' },
    ]);

    expect(group).toEqual({
      id: 'break',
      startTime: 10,
      endTime: 30,
      attributes: { 'X-RESTRICT': 'JUMP', 'X-AD-CREATIVE-SIGNALING': 'e30=' },
    });
  });

  it('treats the hls.js stand-in for an open end as no end', () => {
    const [group] = groupDateRangeCues([
      { id: 'live', startTime: 10, endTime: Number.MAX_VALUE, value: { key: 'X-AD-CREATIVE-SIGNALING', data: 'e30=' } },
    ]);

    expect(group!.endTime).toBe(Number.POSITIVE_INFINITY);
  });
});

describe('findMetadataTrack', () => {
  it('returns the first metadata track and null without one', () => {
    const metadata = Object.assign(new EventTarget(), { kind: 'metadata', cues: null });
    const subtitles = Object.assign(new EventTarget(), { kind: 'subtitles', cues: null });

    expect(findMetadataTrack({ textTracks: { length: 2, 0: subtitles, 1: metadata } })).toBe(metadata);
    expect(findMetadataTrack({ textTracks: { length: 1, 0: subtitles } })).toBeNull();
    expect(findMetadataTrack({})).toBeNull();
  });
});
