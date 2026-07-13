import {
  normalizeRecipient,
  isLidRequiredError,
  resolveRecipientLid,
  sendWithLidFallback,
  RecipientResolutionError,
  getCachedLid,
  setCachedLid,
  clearCachedLid,
  WhatsAppClient,
} from '../../util/recipientResolver';

// ── Mock Logger ──────────────────────────────────────────────────────────────

function createMockLogger() {
  return {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

// ── Mock Client ──────────────────────────────────────────────────────────────

function createMockClient(
  overrides: Partial<WhatsAppClient> = {}
): WhatsAppClient {
  return {
    session: 'test-session',
    status: 'CONNECTED',
    sendText: jest.fn(),
    getPnLidEntry: jest.fn(),
    checkNumberStatus: jest.fn(),
    isConnected: jest.fn().mockResolvedValue(true),
    ...overrides,
  };
}

// ── Test Suite: normalizeRecipient ───────────────────────────────────────────

describe('normalizeRecipient', () => {
  // Case 1: Bare phone → @c.us
  it('converts a bare phone number to @c.us', () => {
    expect(normalizeRecipient('5531996844778')).toBe('5531996844778@c.us');
  });

  // Case 2: Brazilian phone without DDI → prepends 55
  it('auto-prepends DDI 55 for 11-digit Brazilian mobile numbers', () => {
    expect(normalizeRecipient('31996844778')).toBe('5531996844778@c.us');
  });

  it('auto-prepends DDI 55 for 10-digit Brazilian landline numbers', () => {
    expect(normalizeRecipient('3133334444')).toBe(
      '5531333344 44@c.us'.replace(' ', '')
    );
    // Actually: 55 + 3133334444 = 5531333344 44 → 5531333344 44
    expect(normalizeRecipient('3133334444')).toBe(
      '5531333 34444@c.us'.replace(' ', '')
    );
  });

  // Case 3: Already @c.us → no duplication
  it('does not duplicate @c.us suffix', () => {
    expect(normalizeRecipient('5531996844778@c.us')).toBe('5531996844778@c.us');
  });

  // Case 4: @lid identifier → unchanged
  it('passes through @lid identifiers unchanged', () => {
    expect(normalizeRecipient('123456789012345@lid')).toBe(
      '123456789012345@lid'
    );
  });

  // Additional: handles group IDs
  it('passes through @g.us identifiers unchanged', () => {
    expect(normalizeRecipient('120363123456789@g.us')).toBe(
      '120363123456789@g.us'
    );
  });

  // Additional: handles newsletter
  it('passes through @newsletter identifiers', () => {
    expect(normalizeRecipient('120363123456789@newsletter')).toBe(
      '120363123456789@newsletter'
    );
  });

  // Additional: strips non-digit chars
  it('strips non-digit characters from raw phone', () => {
    expect(normalizeRecipient('+55 (31) 99684-4778')).toBe(
      '5531996844778@c.us'
    );
  });

  // Additional: rejects too-short numbers
  it('returns null for numbers shorter than 7 digits', () => {
    expect(normalizeRecipient('12345')).toBeNull();
  });

  // Additional: rejects empty/null
  it('returns null for empty or null input', () => {
    expect(normalizeRecipient('')).toBeNull();
    expect(normalizeRecipient(null as any)).toBeNull();
    expect(normalizeRecipient(undefined as any)).toBeNull();
  });

  // Additional: prevents DDI 55 duplication
  it('does not double-prepend DDI 55', () => {
    // If someone sends 555531996844778, it should detect the double-55
    expect(normalizeRecipient('555531996844778')).toBe('5531996844778@c.us');
  });
});

// ── Test Suite: isLidRequiredError ───────────────────────────────────────────

describe('isLidRequiredError', () => {
  it('detects "No LID for user" error', () => {
    expect(isLidRequiredError(new Error('No LID for user'))).toBe(true);
  });

  it('detects "Lid is missing in chat table" error', () => {
    expect(isLidRequiredError(new Error('Lid is missing in chat table'))).toBe(
      true
    );
  });

  it('detects "account lid not provided" error', () => {
    expect(isLidRequiredError(new Error('account lid not provided'))).toBe(
      true
    );
  });

  it('returns false for unrelated errors', () => {
    expect(isLidRequiredError(new Error('Network timeout'))).toBe(false);
    expect(isLidRequiredError(new Error('WhatsApp rejected message'))).toBe(
      false
    );
  });

  it('handles string errors', () => {
    expect(isLidRequiredError('No LID for user')).toBe(true);
  });

  it('handles null/undefined', () => {
    expect(isLidRequiredError(null)).toBe(false);
    expect(isLidRequiredError(undefined)).toBe(false);
  });
});

// ── Test Suite: LID Cache ────────────────────────────────────────────────────

describe('LID Cache', () => {
  beforeEach(() => {
    clearCachedLid('test', '5531996844778');
  });

  it('stores and retrieves a cached LID', () => {
    setCachedLid('test', '5531996844778', '12345@lid');
    expect(getCachedLid('test', '5531996844778')).toBe('12345@lid');
  });

  it('returns undefined for missing cache entries', () => {
    expect(getCachedLid('test', '5531996844778')).toBeUndefined();
  });

  it('clears a cached entry', () => {
    setCachedLid('test', '5531996844778', '12345@lid');
    clearCachedLid('test', '5531996844778');
    expect(getCachedLid('test', '5531996844778')).toBeUndefined();
  });
});

// ── Test Suite: resolveRecipientLid ──────────────────────────────────────────

describe('resolveRecipientLid', () => {
  beforeEach(() => {
    clearCachedLid('test-session', '5531996844778');
  });

  // Case 5: LID mapping found → returns LID
  it('returns LID when getPnLidEntry finds a mapping', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      getPnLidEntry: jest.fn().mockResolvedValue({
        lid: {
          id: '12345',
          server: 'lid',
          _serialized: '12345@lid',
        },
        phoneNumber: {
          id: '5531996844778',
          server: 'c.us',
          _serialized: '5531996844778@c.us',
        },
      }),
    });

    const result = await resolveRecipientLid(
      client,
      '5531996844778@c.us',
      logger
    );
    expect(result).toBe('12345@lid');
  });

  // Case 6: No LID mapping → returns null
  it('returns null when no LID mapping exists', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      getPnLidEntry: jest.fn().mockResolvedValue({
        lid: undefined,
        phoneNumber: {
          id: '5531996844778',
          server: 'c.us',
          _serialized: '5531996844778@c.us',
        },
      }),
      checkNumberStatus: jest.fn().mockResolvedValue({
        id: { _serialized: '5531996844778@c.us', server: 'c.us' },
        numberExists: true,
      }),
    });

    const result = await resolveRecipientLid(
      client,
      '5531996844778@c.us',
      logger
    );
    expect(result).toBeNull();
  });

  // Case 11: Timeout on PN/LID lookup
  it('does not hang indefinitely on timeout', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      getPnLidEntry: jest
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({}), 30000))
        ),
      checkNumberStatus: jest
        .fn()
        .mockImplementation(
          () => new Promise((resolve) => setTimeout(() => resolve({}), 30000))
        ),
    });

    const result = await resolveRecipientLid(
      client,
      '5531996844778@c.us',
      logger,
      200 // 200ms timeout
    );
    expect(result).toBeNull();
  }, 5000);
});

// ── Test Suite: sendWithLidFallback ──────────────────────────────────────────

describe('sendWithLidFallback', () => {
  beforeEach(() => {
    clearCachedLid('test-session', '5531996844778');
  });

  // Case 5: Direct @lid send
  it('sends directly when recipient is already @lid', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      sendText: jest.fn().mockResolvedValue({ id: 'msg1' }),
    });

    const { result, usedRecipient } = await sendWithLidFallback(
      client,
      '12345@lid',
      'Hello',
      {},
      logger
    );

    expect(usedRecipient).toBe('12345@lid');
    expect(result).toEqual({ id: 'msg1' });
    expect(client.sendText).toHaveBeenCalledWith('12345@lid', 'Hello', {});
  });

  // Case 7: First attempt "No LID", retry with resolved LID succeeds
  it('retries once with resolved LID on "No LID for user" error', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      sendText: jest
        .fn()
        .mockRejectedValueOnce(new Error('No LID for user'))
        .mockResolvedValueOnce({ id: 'msg2' }),
      getPnLidEntry: jest.fn().mockResolvedValue({
        lid: { id: '99999', server: 'lid', _serialized: '99999@lid' },
      }),
    });

    const { result, usedRecipient } = await sendWithLidFallback(
      client,
      '5531996844778@c.us',
      'Hello',
      {},
      logger
    );

    expect(usedRecipient).toBe('99999@lid');
    expect(result).toEqual({ id: 'msg2' });
    // First call with @c.us, second with @lid
    expect(client.sendText).toHaveBeenCalledTimes(2);
  });

  // Case 8: Both attempts fail → controlled error, no loop
  it('throws controlled error when retry also fails', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      sendText: jest
        .fn()
        .mockRejectedValueOnce(new Error('No LID for user'))
        .mockRejectedValueOnce(new Error('No LID for user')),
      getPnLidEntry: jest.fn().mockResolvedValue({
        lid: { id: '99999', server: 'lid', _serialized: '99999@lid' },
      }),
    });

    await expect(
      sendWithLidFallback(client, '5531996844778@c.us', 'Hello', {}, logger)
    ).rejects.toThrow(RecipientResolutionError);

    // Exactly 2 sendText calls: initial + 1 retry
    expect(client.sendText).toHaveBeenCalledTimes(2);
  });

  // Case 8b: LID resolution fails → controlled error
  it('throws when no LID can be resolved after error', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      sendText: jest.fn().mockRejectedValue(new Error('No LID for user')),
      getPnLidEntry: jest.fn().mockResolvedValue({
        lid: undefined,
      }),
      checkNumberStatus: jest.fn().mockResolvedValue({
        id: { _serialized: '5531996844778@c.us' },
        numberExists: true,
      }),
    });

    await expect(
      sendWithLidFallback(client, '5531996844778@c.us', 'Hello', {}, logger)
    ).rejects.toThrow(RecipientResolutionError);

    // Only 1 sendText call — no retry because no LID was found
    expect(client.sendText).toHaveBeenCalledTimes(1);
  });

  // Case 9: Non-LID error is not caught
  it('re-throws non-LID errors without retry', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      sendText: jest.fn().mockRejectedValue(new Error('Network timeout')),
    });

    await expect(
      sendWithLidFallback(client, '5531996844778@c.us', 'Hello', {}, logger)
    ).rejects.toThrow('Network timeout');

    // Only 1 attempt — no retry for non-LID errors
    expect(client.sendText).toHaveBeenCalledTimes(1);
  });

  // Case 6: @c.us succeeds normally (no LID needed)
  it('succeeds with @c.us when no LID error occurs', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      sendText: jest.fn().mockResolvedValue({ id: 'msg3' }),
    });

    const { result, usedRecipient } = await sendWithLidFallback(
      client,
      '5531996844778@c.us',
      'Hello',
      {},
      logger
    );

    expect(usedRecipient).toBe('5531996844778@c.us');
    expect(result).toEqual({ id: 'msg3' });
    expect(client.sendText).toHaveBeenCalledTimes(1);
    // No LID resolution attempted
    expect(client.getPnLidEntry).not.toHaveBeenCalled();
  });

  // Case 12: Concurrent sends to same number
  it('handles concurrent sends without corruption', async () => {
    const logger = createMockLogger();
    let callCount = 0;
    const client = createMockClient({
      sendText: jest.fn().mockImplementation(async () => {
        callCount++;
        return { id: `msg-${callCount}` };
      }),
    });

    const [r1, r2] = await Promise.all([
      sendWithLidFallback(client, '5531996844778@c.us', 'Hello 1', {}, logger),
      sendWithLidFallback(client, '5531996844778@c.us', 'Hello 2', {}, logger),
    ]);

    expect(r1.result).toBeDefined();
    expect(r2.result).toBeDefined();
    // Both should succeed independently
    expect(client.sendText).toHaveBeenCalledTimes(2);
  });

  // assertResult callback is honored
  it('uses the assertResult callback', async () => {
    const logger = createMockLogger();
    const client = createMockClient({
      sendText: jest
        .fn()
        .mockResolvedValue({ id: 'msg4', isSendFailure: true }),
    });

    const assertFn = (result: any, contact: string) => {
      if (result?.isSendFailure) {
        throw new Error(`Rejected by ${contact}`);
      }
      return result;
    };

    await expect(
      sendWithLidFallback(
        client,
        '5531996844778@c.us',
        'Hello',
        {},
        logger,
        assertFn
      )
    ).rejects.toThrow('Rejected by 5531996844778@c.us');
  });
});
