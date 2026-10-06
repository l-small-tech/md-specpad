import { describe, expect, it } from 'vitest';
import { splitAgentStatus } from '../tab-status';

describe('splitAgentStatus', () => {
  it('reads the two states Claude Code actually writes', () => {
    // Idle prefix (also what a finished turn shows).
    expect(splitAgentStatus('✳ md-specpad')).toEqual({
      cue: { activity: 'ready', glyph: '✳', label: 'Ready' },
      rest: 'md-specpad',
    });
    // The alternating spinner frames while it works.
    for (const glyph of ['◐', '◑']) {
      expect(splitAgentStatus(`${glyph} md-specpad`).cue?.activity).toBe('working');
    }
  });

  it('classifies the common spinner, done, blocked and failed families', () => {
    expect(splitAgentStatus('⠹ building').cue?.activity).toBe('working');
    expect(splitAgentStatus('⣾ building').cue?.activity).toBe('working');
    expect(splitAgentStatus('✔ done').cue?.activity).toBe('ready');
    expect(splitAgentStatus('⏸ permission').cue?.activity).toBe('waiting');
    expect(splitAgentStatus('✘ failed').cue?.activity).toBe('error');
  });

  it('labels each activity for the screen reader', () => {
    expect(splitAgentStatus('◐ x').cue?.label).toBe('Working');
    expect(splitAgentStatus('⚠️ x').cue?.label).toBe('Needs input');
  });

  it('tolerates an emoji variation selector after the glyph', () => {
    expect(splitAgentStatus('⚠️ heads up')).toEqual({
      cue: { activity: 'waiting', glyph: '⚠', label: 'Needs input' },
      rest: 'heads up',
    });
  });

  it('leaves a title with no known glyph exactly as it came', () => {
    for (const title of ['bash', '~/src ✗', '→ deploy', 'zsh — 80×24']) {
      expect(splitAgentStatus(title)).toEqual({ cue: null, rest: title });
    }
  });

  it('needs a real title after the glyph — a lone glyph is the title', () => {
    expect(splitAgentStatus('✳')).toEqual({ cue: null, rest: '✳' });
    expect(splitAgentStatus('✳ ')).toEqual({ cue: null, rest: '✳ ' });
  });

  it('is a no-op on an empty title', () => {
    expect(splitAgentStatus('')).toEqual({ cue: null, rest: '' });
  });
});
