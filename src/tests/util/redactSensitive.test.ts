import {
  redactSensitive,
  containsSensitiveData,
  redactUrlCode,
  redactPhoneCode,
} from '../../util/redactSensitive';

describe('redactSensitive', () => {
  it('redacts WhatsApp linking URLs', () => {
    const input =
      'Code: https://wa.me/settings/linked_devices#2@pHYSLlu8RgMrAq3ru910B4eNCa2Z+xbDsb5yfeDYUTZj1kApLymwQ8CcS87PkXbp3I/VRMPTToIl4CZiWJs5MABgnK1Z+oIMHtk=';
    const result = redactSensitive(input);
    expect(result).toBe('Code: [REDACTED wa.me linking URL]');
    expect(result).not.toContain('pHYSLlu8');
  });

  it('redacts Authorization headers', () => {
    const input =
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def';
    const result = redactSensitive(input);
    expect(result).toContain('[REDACTED]');
    expect(result).not.toContain('eyJhbGci');
  });

  it('preserves normal log messages', () => {
    const input = 'State Change CONNECTED: central';
    expect(redactSensitive(input)).toBe(input);
  });

  it('handles non-string input gracefully', () => {
    expect(redactSensitive(null as any)).toBeNull();
    expect(redactSensitive(undefined as any)).toBeUndefined();
    expect(redactSensitive(42 as any)).toBe(42);
  });
});

describe('containsSensitiveData', () => {
  it('detects linking URLs', () => {
    expect(
      containsSensitiveData('https://wa.me/settings/linked_devices#code123')
    ).toBe(true);
  });

  it('returns false for normal text', () => {
    expect(containsSensitiveData('[Bot] Iniciado.')).toBe(false);
  });

  it('returns false for non-string', () => {
    expect(containsSensitiveData(123 as any)).toBe(false);
  });
});

describe('redactUrlCode', () => {
  it('redacts linking URL keeping host', () => {
    const url =
      'https://wa.me/settings/linked_devices#2@pHYSLlu8RgMrAq3ru910B4eNCa2Z';
    const result = redactUrlCode(url);
    expect(result).toBe('https://wa.me/settings/linked_devices#[REDACTED]');
  });

  it('redacts long non-URL codes', () => {
    const code = 'ABCDEFGHIJKLMNOP';
    const result = redactUrlCode(code);
    expect(result).toBe('ABCDEFGH...[REDACTED]');
  });

  it('keeps short codes unchanged', () => {
    expect(redactUrlCode('AB12')).toBe('AB12');
  });

  it('handles empty/null', () => {
    expect(redactUrlCode(null)).toBe('[empty]');
    expect(redactUrlCode(undefined)).toBe('[empty]');
    expect(redactUrlCode('')).toBe('[empty]');
  });
});

describe('redactPhoneCode', () => {
  it('masks pairing code showing last 2 chars', () => {
    expect(redactPhoneCode('12345678')).toBe('******78');
  });

  it('keeps short codes', () => {
    expect(redactPhoneCode('AB')).toBe('AB');
  });

  it('handles empty/null', () => {
    expect(redactPhoneCode(null)).toBe('[empty]');
    expect(redactPhoneCode('')).toBe('[empty]');
  });
});
