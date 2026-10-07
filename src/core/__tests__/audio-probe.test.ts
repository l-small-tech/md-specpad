import { describe, expect, test } from 'vitest';
import { probeAudio } from '../audio-probe';

/** Little builder: ASCII strings, byte arrays and LE/BE integers in sequence. */
function bytes(...parts: (string | number[] | Uint8Array)[]): Uint8Array {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') {
      for (const ch of part) out.push(ch.charCodeAt(0));
    } else {
      out.push(...part);
    }
  }
  return new Uint8Array(out);
}
const u16le = (v: number) => [v & 0xff, v >> 8];
const u32le = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24];
const u16be = (v: number) => [v >> 8, v & 0xff];
const u32be = (v: number) => [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];

describe('probeAudio', () => {
  test('WAV: skips a LIST chunk to reach fmt', () => {
    const wav = bytes(
      'RIFF',
      u32le(0),
      'WAVE',
      'LIST',
      u32le(3),
      [1, 2, 3, 0], // odd size + pad byte
      'fmt ',
      u32le(16),
      u16le(1), // PCM
      u16le(2),
      u32le(44100),
      u32le(44100 * 4),
      u16le(4),
      u16le(16),
    );
    expect(probeAudio(wav)).toEqual({ codec: 'PCM', channels: 2, sampleRate: 44100, bitDepth: 16 });
  });

  test('FLAC STREAMINFO: 48 kHz, stereo, 24-bit', () => {
    // rate 48000 = 0x0BB80 (20 bits), channels-1 = 1 (3 bits), bps-1 = 23 (5 bits)
    const packed = [0x0b, 0xb8, (0x0 << 4) | (1 << 1) | (23 >> 4), (23 & 0xf) << 4];
    const flac = bytes('fLaC', [0, 0, 0, 34], new Array(10).fill(0), packed, new Array(20).fill(0));
    expect(probeAudio(flac)).toEqual({
      codec: 'FLAC',
      sampleRate: 48000,
      channels: 2,
      bitDepth: 24,
    });
  });

  test('MP3 after an ID3v2 tag', () => {
    const id3 = bytes('ID3', [4, 0, 0], [0, 0, 0, 4], [0, 0, 0, 0]);
    // MPEG1 Layer III, 128 kbps, 44.1 kHz, mono
    const frame = [0xff, 0xfb, 0x90, 0xc0];
    expect(probeAudio(bytes(id3, frame))).toEqual({
      codec: 'MP3',
      sampleRate: 44100,
      channels: 1,
      bitDepth: null,
    });
  });

  test('ADTS AAC', () => {
    // sync, MPEG-4, no CRC; profile LC, rate index 4 (44.1k), channels 2
    const adts = bytes([0xff, 0xf1, (1 << 6) | (4 << 2) | 0, 2 << 6, 0, 0, 0]);
    expect(probeAudio(adts)).toMatchObject({ codec: 'AAC', sampleRate: 44100, channels: 2 });
  });

  test('Ogg Opus reports its 48 kHz playback rate', () => {
    const page = bytes(
      'OggS',
      new Array(22).fill(0),
      [1],
      [19],
      'OpusHead',
      [1, 1],
      u16le(0),
      u32le(16000),
    );
    expect(probeAudio(page)).toEqual({
      codec: 'Opus',
      channels: 1,
      sampleRate: 48000,
      bitDepth: null,
    });
  });

  test('Ogg Vorbis', () => {
    const page = bytes(
      'OggS',
      new Array(22).fill(0),
      [1],
      [30],
      [1],
      'vorbis',
      u32le(0),
      [2],
      u32le(22050),
    );
    expect(probeAudio(page)).toEqual({
      codec: 'Vorbis',
      channels: 2,
      sampleRate: 22050,
      bitDepth: null,
    });
  });

  test('M4A: finds the mp4a sample entry anywhere', () => {
    const entry = bytes(
      u32be(36),
      'mp4a',
      new Array(8).fill(0),
      new Array(8).fill(0),
      u16be(2),
      u16be(16),
      [0, 0, 0, 0],
      u32be(44100 << 16),
    );
    const file = bytes(u32be(16), 'ftypM4A ', [0, 0, 0, 0], new Array(40).fill(0), entry);
    expect(probeAudio(file)).toEqual({
      codec: 'AAC',
      channels: 2,
      sampleRate: 44100,
      bitDepth: null,
    });
  });

  test('unknown or truncated input is all-null, never throws', () => {
    const unknown = { codec: null, sampleRate: null, channels: null, bitDepth: null };
    expect(probeAudio(bytes('hello world'))).toEqual(unknown);
    expect(probeAudio(bytes('fLaC', [0, 0]))).toEqual(unknown);
    expect(probeAudio(bytes('RIFF', u32le(0), 'WAVE', 'fmt ', u32le(16), [1]))).toEqual(unknown);
    expect(probeAudio(new Uint8Array())).toEqual(unknown);
  });
});
