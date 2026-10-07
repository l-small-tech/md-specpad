import { describe, expect, test } from 'vitest';
import { identityMissing, validateIdentity } from '../identity';

describe('identityMissing', () => {
  test('unknown (not loaded) is not missing; either half unset is', () => {
    expect(identityMissing(null)).toBe(false);
    expect(identityMissing({ name: 'Ann', email: 'a@b.c' })).toBe(false);
    expect(identityMissing({ name: null, email: 'a@b.c' })).toBe(true);
    expect(identityMissing({ name: 'Ann', email: null })).toBe(true);
  });
});

describe('validateIdentity', () => {
  test('a plain name and email pass, surrounding spaces ignored', () => {
    expect(validateIdentity(' Ann Example ', ' ann@example.com ')).toBeNull();
    expect(validateIdentity('Ann', '123+ann@users.noreply.github.com')).toBeNull();
  });

  test('empty fields ask for the missing one', () => {
    expect(validateIdentity('', 'a@b.c')).toBe('Enter your name');
    expect(validateIdentity('Ann', '  ')).toBe('Enter your email');
  });

  test('typos and what git cannot store are caught', () => {
    expect(validateIdentity('Ann', 'ann.example.com')).toMatch(/email/);
    expect(validateIdentity('Ann', 'ann @x.com')).toMatch(/email/);
    expect(validateIdentity('-Ann', 'a@b.c')).toMatch(/name/);
    expect(validateIdentity('Ann <x>', 'a@b.c')).toMatch(/name/);
    expect(validateIdentity('Ann\nB', 'a@b.c')).toMatch(/name/);
  });
});
