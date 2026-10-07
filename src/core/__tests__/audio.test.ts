import { describe, expect, test } from 'vitest';
import {
  audioMimeType,
  bitrateLabel,
  channelLabel,
  computePeaks,
  downmix,
  formatBytes,
  formatClock,
  formatDb,
  isAudioPath,
  measureLevels,
  peakExtent,
  resamplePeaks,
  rulerStep,
  sampleRateLabel,
} from '../audio';

describe('isAudioPath / audioMimeType', () => {
  test('recognizes audio extensions case-insensitively', () => {
    expect(isAudioPath('C:\\notes\\memo.MP3')).toBe(true);
    expect(isAudioPath('/a/b/take.flac')).toBe(true);
    expect(isAudioPath('/a/b/voice.opus')).toBe(true);
    expect(isAudioPath('/a/b/notes.md')).toBe(false);
    expect(isAudioPath('/a/b/clip.webm')).toBe(false); // usually video
    expect(isAudioPath('/a/b/mp3')).toBe(false);
  });

  test('maps extensions to playable MIME types', () => {
    expect(audioMimeType('x.mp3')).toBe('audio/mpeg');
    expect(audioMimeType('x.m4a')).toBe('audio/mp4');
    expect(audioMimeType('x.txt')).toBe('application/octet-stream');
  });
});

describe('computePeaks', () => {
  test('takes each slice min/max across all channels', () => {
    const left = new Float32Array([0.1, -0.5, 0.2, 0.9]);
    const right = new Float32Array([-0.8, 0.3, 0, 0.1]);
    expect(Array.from(computePeaks([left, right], 2))).toEqual([
      expect.closeTo(-0.8),
      expect.closeTo(0.3),
      0,
      expect.closeTo(0.9),
    ]);
  });

  test('empty slices and empty input read as silence', () => {
    expect(Array.from(computePeaks([new Float32Array([0.5])], 2))).toEqual([0, 0, 0, 0.5]);
    expect(Array.from(computePeaks([], 3))).toEqual([0, 0, 0, 0, 0, 0]);
    expect(computePeaks([new Float32Array([1])], 0)).toHaveLength(0);
  });
});

describe('resamplePeaks / peakExtent', () => {
  test('merges slots into fewer bars by their extremes', () => {
    const peaks = new Float32Array([-0.1, 0.2, -0.5, 0.1, 0, 0.9, -0.3, 0.3]);
    expect(Array.from(resamplePeaks(peaks, 2))).toEqual([
      expect.closeTo(-0.5),
      expect.closeTo(0.2),
      expect.closeTo(-0.3),
      expect.closeTo(0.9),
    ]);
    expect(peakExtent(peaks)).toBeCloseTo(0.9);
  });

  test('more bars than slots repeats slots; empty input is empty', () => {
    const peaks = new Float32Array([-0.5, 0.5]);
    expect(Array.from(resamplePeaks(peaks, 3))).toEqual([-0.5, 0.5, -0.5, 0.5, -0.5, 0.5]);
    expect(resamplePeaks(new Float32Array(), 4)).toEqual(new Float32Array(8));
    expect(peakExtent(new Float32Array())).toBe(0);
  });
});

describe('measureLevels', () => {
  test('full-scale square wave: 0 dB peak and RMS', () => {
    const levels = measureLevels([new Float32Array([1, -1, 1, -1])]);
    expect(levels.peakDb).toBeCloseTo(0);
    expect(levels.rmsDb).toBeCloseTo(0);
  });

  test('half amplitude is about -6 dB', () => {
    const levels = measureLevels([new Float32Array([0.5, -0.5])]);
    expect(levels.peakDb).toBeCloseTo(-6.02, 1);
  });

  test('silence is -Infinity', () => {
    const levels = measureLevels([new Float32Array(4)]);
    expect(levels.peakDb).toBe(-Infinity);
    expect(levels.rmsDb).toBe(-Infinity);
    expect(measureLevels([]).rmsDb).toBe(-Infinity);
  });
});

describe('formatDb', () => {
  test('uses a real minus sign and one decimal', () => {
    expect(formatDb(-3.24)).toBe('−3.2 dB');
    expect(formatDb(0)).toBe('0.0 dB');
    expect(formatDb(-Infinity)).toBe('−∞ dB');
  });
});

describe('downmix', () => {
  test('averages channels and passes mono through', () => {
    const mono = new Float32Array([0.25]);
    expect(downmix([mono])).toBe(mono);
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, -1])]))).toEqual([
      0.5, -0.5,
    ]);
    expect(downmix([])).toHaveLength(0);
  });
});

describe('formatClock', () => {
  test('m:ss under an hour, h:mm:ss beyond', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65.9)).toBe('1:05');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  test('tenths and junk input', () => {
    expect(formatClock(12.34, true)).toBe('0:12.3');
    expect(formatClock(-4)).toBe('0:00');
    expect(formatClock(Number.NaN)).toBe('0:00');
  });
});

describe('rulerStep', () => {
  test('picks the smallest round step that fits', () => {
    expect(rulerStep(10, 720)).toBe(1); // 10 labels fit
    expect(rulerStep(180, 720)).toBe(30); // 6 labels
    expect(rulerStep(3600, 720)).toBe(600);
  });

  test('very long tracks fall back to whole hours; junk is 1', () => {
    expect(rulerStep(100 * 3600, 144)).toBe(50 * 3600);
    expect(rulerStep(0, 500)).toBe(1);
    expect(rulerStep(60, 0)).toBe(1);
  });
});

describe('labels', () => {
  test('bytes', () => {
    expect(formatBytes(96)).toBe('96 B');
    expect(formatBytes(812 * 1024)).toBe('812 KB');
    expect(formatBytes(4.2 * 1024 * 1024)).toBe('4.2 MB');
    expect(formatBytes(42 * 1024 * 1024)).toBe('42 MB');
  });

  test('channels, rate, bitrate', () => {
    expect(channelLabel(1)).toBe('mono');
    expect(channelLabel(2)).toBe('stereo');
    expect(channelLabel(6)).toBe('6 ch');
    expect(sampleRateLabel(44100)).toBe('44.1 kHz');
    expect(sampleRateLabel(48000)).toBe('48 kHz');
    expect(bitrateLabel(16000 * 10, 10)).toBe('128 kbps');
    expect(bitrateLabel(100, 0)).toBeNull();
  });
});
