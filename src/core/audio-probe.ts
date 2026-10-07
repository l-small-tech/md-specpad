/**
 * Read an audio file's own header for the facts Web Audio hides: the codec,
 * the NATIVE sample rate, the channel count and (for lossless) the bit depth.
 * `decodeAudioData` resamples everything to its context's rate, so the rate it
 * reports is never the file's.
 *
 * Deliberately shallow — enough of WAV, FLAC, MP3, ADTS AAC, Ogg (Opus and
 * Vorbis) and MP4/M4A to find those fields, nothing more. Anything
 * unrecognized (WebM, a damaged header) comes back as all-null, and the audio
 * tab simply shows fewer facts.
 */

export interface AudioProbe {
  readonly codec: string | null;
  readonly sampleRate: number | null;
  readonly channels: number | null;
  /** Bits per sample, for PCM/FLAC/ALAC; null for lossy codecs. */
  readonly bitDepth: number | null;
}

const UNKNOWN: AudioProbe = { codec: null, sampleRate: null, channels: null, bitDepth: null };

export function probeAudio(bytes: Uint8Array): AudioProbe {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') {
      return probeWav(bytes, view);
    }
    if (ascii(bytes, 0, 4) === 'fLaC') {
      return probeFlac(bytes);
    }
    if (ascii(bytes, 0, 4) === 'OggS') {
      return probeOgg(bytes, view);
    }
    if (ascii(bytes, 4, 4) === 'ftyp') {
      return probeMp4(bytes, view);
    }
    return probeMpegStream(bytes);
  } catch {
    // A truncated header indexes past the end (DataView throws RangeError).
    return UNKNOWN;
  }
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = at; i < at + length && i < bytes.length; i++) {
    out += String.fromCharCode(bytes[i] ?? 0);
  }
  return out;
}

function byte(bytes: Uint8Array, at: number): number {
  const v = bytes[at];
  if (v === undefined) {
    throw new RangeError('past end');
  }
  return v;
}

/* ---- WAV: walk the RIFF chunks to "fmt " ---------------------------------- */

function probeWav(bytes: Uint8Array, view: DataView): AudioProbe {
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = ascii(bytes, at, 4);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      const format = view.getUint16(at + 8, true);
      const bitDepth = view.getUint16(at + 22, true);
      return {
        // 3 = IEEE float; 0xFFFE (extensible) and 1 are integer PCM in practice.
        codec: format === 3 ? 'PCM float' : 'PCM',
        channels: view.getUint16(at + 10, true),
        sampleRate: view.getUint32(at + 12, true),
        bitDepth,
      };
    }
    at += 8 + size + (size % 2); // chunks are word-aligned
  }
  return UNKNOWN;
}

/* ---- FLAC: STREAMINFO is always the first metadata block ------------------ */

function probeFlac(bytes: Uint8Array): AudioProbe {
  // "fLaC" + 4-byte block header; STREAMINFO body starts at 8, the packed
  // rate/channels/depth fields at body offset 10.
  const a = byte(bytes, 18);
  const b = byte(bytes, 19);
  const c = byte(bytes, 20);
  const d = byte(bytes, 21);
  return {
    codec: 'FLAC',
    sampleRate: (a << 12) | (b << 4) | (c >> 4),
    channels: ((c >> 1) & 0x7) + 1,
    bitDepth: (((c & 0x1) << 4) | (d >> 4)) + 1,
  };
}

/* ---- Ogg: the first packet names the codec -------------------------------- */

function probeOgg(bytes: Uint8Array, view: DataView): AudioProbe {
  const segments = byte(bytes, 26);
  const packet = 27 + segments;
  if (ascii(bytes, packet, 8) === 'OpusHead') {
    // Opus always decodes at 48 kHz; the header's "input rate" is only what
    // the encoder was fed, so 48 kHz is the honest playback rate.
    return { codec: 'Opus', channels: byte(bytes, packet + 9), sampleRate: 48000, bitDepth: null };
  }
  if (byte(bytes, packet) === 1 && ascii(bytes, packet + 1, 6) === 'vorbis') {
    return {
      codec: 'Vorbis',
      channels: byte(bytes, packet + 11),
      sampleRate: view.getUint32(packet + 12, true),
      bitDepth: null,
    };
  }
  return UNKNOWN;
}

/* ---- MP4 / M4A: find the audio sample entry ------------------------------- */

function probeMp4(bytes: Uint8Array, view: DataView): AudioProbe {
  // The sample entry can sit anywhere (moov is often at the END of the file),
  // so scan for its four-character type rather than walking the box tree.
  for (let i = 4; i + 4 <= bytes.length; i++) {
    const type = ascii(bytes, i, 4);
    if (type !== 'mp4a' && type !== 'alac') {
      continue;
    }
    const box = i - 4; // the size field precedes the type
    // Sample entry: 8 box header + 8 (reserved, data ref) + 8 (version,
    // revision, vendor), then channels, sample size, 4 bytes, rate 16.16.
    const channels = view.getUint16(box + 24, false);
    const sampleSize = view.getUint16(box + 26, false);
    const sampleRate = view.getUint16(box + 32, false);
    if (channels < 1 || channels > 32 || sampleRate === 0) {
      continue; // the bytes happened to spell the name — not the real box
    }
    return {
      codec: type === 'alac' ? 'ALAC' : 'AAC',
      channels,
      sampleRate,
      bitDepth: type === 'alac' ? sampleSize : null,
    };
  }
  return UNKNOWN;
}

/* ---- MP3 / ADTS AAC: the first frame header ------------------------------- */

const MPEG_RATES: Record<number, readonly number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
};

const ADTS_RATES = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
];

function probeMpegStream(bytes: Uint8Array): AudioProbe {
  let at = 0;
  // Skip an ID3v2 tag: "ID3", version, flags, then a 28-bit synchsafe size.
  if (ascii(bytes, 0, 3) === 'ID3') {
    const size =
      ((byte(bytes, 6) & 0x7f) << 21) |
      ((byte(bytes, 7) & 0x7f) << 14) |
      ((byte(bytes, 8) & 0x7f) << 7) |
      (byte(bytes, 9) & 0x7f);
    const footer = (byte(bytes, 5) & 0x10) !== 0 ? 10 : 0;
    at = 10 + size + footer;
  }
  // Frame sync within the first 64 KiB after any tag (some files pad).
  const limit = Math.min(bytes.length - 3, at + 65536);
  for (let i = at; i < limit; i++) {
    if (byte(bytes, i) !== 0xff || (byte(bytes, i + 1) & 0xe0) !== 0xe0) {
      continue;
    }
    const b1 = byte(bytes, i + 1);
    const b2 = byte(bytes, i + 2);
    const b3 = byte(bytes, i + 3);
    // ADTS: 12-bit sync, layer 00.
    if ((b1 & 0xf6) === 0xf0) {
      const rate = ADTS_RATES[(b2 >> 2) & 0xf];
      const channels = ((b2 & 0x1) << 2) | (b3 >> 6);
      if (rate) {
        return { codec: 'AAC', sampleRate: rate, channels: channels || null, bitDepth: null };
      }
      continue;
    }
    const version = (b1 >> 3) & 0x3;
    const layer = (b1 >> 1) & 0x3;
    const rate = MPEG_RATES[version]?.[(b2 >> 2) & 0x3];
    const bitrateIndex = b2 >> 4;
    if (layer === 0 || !rate || bitrateIndex === 0xf) {
      continue; // reserved values: a false sync inside other data
    }
    return {
      codec: layer === 1 ? 'MP3' : layer === 2 ? 'MP2' : 'MP1',
      sampleRate: rate,
      channels: b3 >> 6 === 3 ? 1 : 2,
      bitDepth: null,
    };
  }
  return UNKNOWN;
}
