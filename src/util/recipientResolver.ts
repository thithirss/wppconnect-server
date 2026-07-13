/*
 * Copyright 2021 WPPConnect Team
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Centralized WhatsApp recipient resolution with LID support.
 *
 * Modern WhatsApp Web versions may require messages to be addressed using
 * a privacy-preserving Linked Identity (LID) instead of the legacy
 * phone-number-based @c.us JID.  This module provides utilities to:
 *
 *  1. Normalize raw phone inputs into valid @c.us JIDs.
 *  2. Resolve PN↔LID mappings via the installed wppconnect API.
 *  3. Transparently retry a failed send once using the resolved LID.
 *  4. Cache resolved LIDs to avoid repeated lookups.
 *
 * Design constraints:
 *  - Never fabricate a LID from a phone number.
 *  - At most one retry after a "No LID" failure.
 *  - Thread-safe for concurrent sends to the same recipient.
 */

import { Logger } from 'winston';

// ── Types ────────────────────────────────────────────────────────────────────

/** Mirrors @wppconnect/wa-js PnLidWid — not re-exported to avoid coupling. */
export interface PnLidWid {
  id: string;
  server: string;
  _serialized: string;
}

/** Mirrors @wppconnect/wa-js PnLidEntryResult. */
export interface PnLidEntryResult {
  lid?: PnLidWid;
  phoneNumber?: PnLidWid;
  contact?: Record<string, unknown>;
}

/** Minimal subset of the wppconnect client used by this module. */
export interface WhatsAppClient {
  session: string;
  status?: string;
  sendText(to: string, content: string, options?: unknown): Promise<unknown>;
  getPnLidEntry(phoneOrLid: string): Promise<PnLidEntryResult>;
  checkNumberStatus(contactId: string): Promise<{
    id: { _serialized: string; server?: string };
    numberExists: boolean;
    [key: string]: unknown;
  }>;
  isConnected(): Promise<boolean>;
}

/** Result of a send attempt with LID fallback. */
export interface SendResult {
  /** The raw result returned by sendText. */
  result: unknown;
  /** The actual recipient JID used for the successful send. */
  usedRecipient: string;
}

/** Error subclass carrying structured information about send failures. */
export class RecipientResolutionError extends Error {
  public readonly reason:
    | 'invalid_format'
    | 'no_whatsapp'
    | 'lid_unavailable'
    | 'lid_required'
    | 'session_not_ready'
    | 'timeout'
    | 'send_failed';

  public readonly recipient: string;

  constructor(
    message: string,
    reason: RecipientResolutionError['reason'],
    recipient: string
  ) {
    super(message);
    this.name = 'RecipientResolutionError';
    this.reason = reason;
    this.recipient = recipient;
  }
}

// ── LID Cache ────────────────────────────────────────────────────────────────

const recipientLidCache = new Map<string, { lid: string; expiresAt: number }>();
const RECIPIENT_LID_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Prevent concurrent LID resolutions for the same recipient from
// triggering multiple getPnLidEntry calls in parallel.
const resolutionInFlight = new Map<string, Promise<string | null>>();

export function getCachedLid(
  session: string,
  phone: string
): string | undefined {
  const key = `${session}:${phone}`;
  const cached = recipientLidCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.lid;
  }
  if (cached) {
    recipientLidCache.delete(key);
  }
  return undefined;
}

export function setCachedLid(
  session: string,
  phone: string,
  lid: string
): void {
  const key = `${session}:${phone}`;
  recipientLidCache.set(key, {
    lid,
    expiresAt: Date.now() + RECIPIENT_LID_CACHE_TTL_MS,
  });
}

export function clearCachedLid(session: string, phone: string): void {
  const key = `${session}:${phone}`;
  recipientLidCache.delete(key);
}

// ── Normalization ────────────────────────────────────────────────────────────

/**
 * Normalizes a raw phone input into a valid WhatsApp recipient identifier.
 *
 * Rules:
 *  1. If already `@lid`, return unchanged.
 *  2. If already `@c.us` or `@g.us` or `@newsletter`, return unchanged.
 *  3. Strip non-digit characters.
 *  4. For Brazilian numbers (10-11 digits without country code), prepend 55.
 *  5. Append `@c.us`.
 *
 * @returns Normalized JID string, or null if the input is invalid.
 */
export function normalizeRecipient(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Already a fully-qualified identifier — pass through
  if (trimmed.endsWith('@lid')) return trimmed;
  if (trimmed.endsWith('@c.us')) return trimmed;
  if (trimmed.endsWith('@g.us')) return trimmed;
  if (trimmed.endsWith('@newsletter')) return trimmed;
  if (trimmed.endsWith('@broadcast')) return trimmed;

  // Extract only digits
  const digits = trimmed.replace(/\D/g, '');
  if (!digits || digits.length < 7) return null; // Too short to be a phone number

  // Auto-prepend Brazilian DDI if the number looks like a local BR number
  // Brazilian mobile: 11 digits (DDD + 9 + 8 digits)
  // Brazilian landline: 10 digits (DDD + 8 digits)
  let normalized = digits;
  if (normalized.length === 10 || normalized.length === 11) {
    // Only prepend 55 if it doesn't already start with a country code
    // (Brazilian DDD ranges from 11 to 99, never starts with 0)
    normalized = '55' + normalized;
  }

  // Prevent duplicating DDI 55
  if (
    normalized.length >= 14 &&
    normalized.startsWith('5555') &&
    !normalized.startsWith('55550')
  ) {
    // Likely a double-55 — e.g., user sent 555531996844778
    // Only strip if the remaining digits form a valid BR number
    const withoutFirst55 = normalized.substring(2);
    if (withoutFirst55.length === 12 || withoutFirst55.length === 13) {
      normalized = withoutFirst55;
    }
  }

  return `${normalized}@c.us`;
}

// ── LID Error Detection ──────────────────────────────────────────────────────

/** Known error messages that indicate a LID is required but missing. */
const LID_ERROR_PATTERNS = [
  'no lid for user',
  'lid is missing in chat table',
  'account lid not provided',
  'lid not found',
];

/**
 * Returns true if an error indicates that WhatsApp requires a LID
 * identifier instead of the legacy @c.us JID.
 */
export function isLidRequiredError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error || '');
  const lower = message.toLowerCase();
  return LID_ERROR_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ── LID Resolution ───────────────────────────────────────────────────────────

/**
 * Attempts to resolve a @c.us JID to its corresponding @lid identifier
 * using the wppconnect `getPnLidEntry` API.
 *
 * Returns the `@lid` serialized string, or null if no mapping exists.
 * Never fabricates a LID — only returns server-provided values.
 */
export async function resolveRecipientLid(
  client: WhatsAppClient,
  contact: string,
  logger: Logger,
  timeoutMs = 10000
): Promise<string | null> {
  const phone = contact.split('@')[0];
  const session = client.session || 'default';
  const cacheKey = `${session}:${phone}`;

  // Check cache first
  const cached = getCachedLid(session, phone);
  if (cached) {
    logger.debug(`[sendMessage] Using cached LID for ${contact}.`);
    return cached;
  }

  // Deduplicate concurrent resolutions for the same recipient
  const existing = resolutionInFlight.get(cacheKey);
  if (existing) {
    logger.debug(
      `[sendMessage] Waiting for in-flight LID resolution for ${contact}.`
    );
    return existing;
  }

  const resolution = (async (): Promise<string | null> => {
    // Strategy 1: Direct PN↔LID lookup
    try {
      logger.info(`[sendMessage] Looking up PN/LID mapping for ${contact}.`);
      const mapping = await withInternalTimeout(
        client.getPnLidEntry(contact),
        timeoutMs,
        `getPnLidEntry ${contact}`
      );

      if (mapping?.lid?._serialized?.endsWith('@lid')) {
        const lid = mapping.lid._serialized;
        logger.info(`[sendMessage] LID mapping found for ${contact}.`);
        setCachedLid(session, phone, lid);
        return lid;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.debug(
        `[sendMessage] Direct PN/LID lookup failed for ${contact}: ${msg}`
      );
    }

    // Strategy 2: checkNumberStatus may return a LID-based id on newer accounts
    try {
      const profile = await withInternalTimeout(
        client.checkNumberStatus(contact),
        timeoutMs,
        `checkNumberStatus ${contact}`
      );

      if (profile?.numberExists && profile?.id?._serialized?.endsWith('@lid')) {
        const lid = profile.id._serialized;
        logger.info(
          `[sendMessage] LID found via checkNumberStatus for ${contact}.`
        );
        setCachedLid(session, phone, lid);
        return lid;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.debug(
        `[sendMessage] checkNumberStatus lookup failed for ${contact}: ${msg}`
      );
    }

    logger.info(
      `[sendMessage] No LID mapping available for ${contact}. Evaluating c.us fallback.`
    );
    return null;
  })();

  resolutionInFlight.set(cacheKey, resolution);
  try {
    return await resolution;
  } finally {
    resolutionInFlight.delete(cacheKey);
  }
}

// ── Send with LID Fallback ───────────────────────────────────────────────────

/**
 * Sends a text message with automatic LID fallback.
 *
 * Flow:
 *  1. If the recipient already ends with @lid, send directly.
 *  2. Check if we have a cached LID → try that first.
 *  3. Otherwise, try sending with the @c.us JID.
 *  4. If the send fails with a "No LID" error:
 *     a. Resolve the PN↔LID mapping.
 *     b. If a LID is found, retry once with the @lid JID.
 *     c. If no LID is found, throw a clear error.
 *  5. Never retry more than once.
 */
export async function sendWithLidFallback(
  client: WhatsAppClient,
  contact: string,
  message: string,
  options: unknown,
  logger: Logger,
  assertResult?: (result: unknown, contact: string) => unknown
): Promise<SendResult> {
  const session = client.session || 'default';
  const phone = contact.split('@')[0];
  const doAssert = assertResult || ((r: unknown) => r);

  // ── If already @lid, send directly ────────────────────────────────
  if (contact.endsWith('@lid')) {
    logger.info(`[sendMessage] Sending directly to LID recipient.`);
    const result = doAssert(
      await client.sendText(contact, message, options),
      contact
    );
    return { result, usedRecipient: contact };
  }

  // ── Try cached LID first ──────────────────────────────────────────
  const cachedLid = getCachedLid(session, phone);
  if (cachedLid) {
    logger.debug(`[sendMessage] Using cached LID for ${contact}.`);
    try {
      const result = doAssert(
        await client.sendText(cachedLid, message, options),
        cachedLid
      );
      return { result, usedRecipient: cachedLid };
    } catch (error) {
      clearCachedLid(session, phone);
      if (!isLidRequiredError(error)) throw error;
      // Cached LID is stale — fall through to fresh resolution
      logger.info(
        `[sendMessage] Cached LID is stale for ${contact}. Re-resolving.`
      );
    }
  }

  // ── Try sending with @c.us ────────────────────────────────────────
  try {
    logger.info(`[sendMessage] Normalized recipient: ${contact}`);
    const result = doAssert(
      await client.sendText(contact, message, options),
      contact
    );
    return { result, usedRecipient: contact };
  } catch (error) {
    if (!isLidRequiredError(error)) throw error;

    logger.info(
      `[sendMessage] Send failed because WhatsApp requires LID for ${contact}.`
    );
  }

  // ── Resolve LID and retry once ────────────────────────────────────
  logger.info(`[sendMessage] Retrying once with refreshed LID for ${contact}.`);

  const resolvedLid = await resolveRecipientLid(client, contact, logger);

  if (!resolvedLid || !resolvedLid.endsWith('@lid')) {
    throw new RecipientResolutionError(
      `WhatsApp requires LID for ${contact} but no LID mapping could be resolved. ` +
        'The contact may not exist on WhatsApp or the mapping is not yet available.',
      'lid_required',
      contact
    );
  }

  logger.info(`[sendMessage] Sending using LID recipient for ${contact}.`);

  try {
    const result = doAssert(
      await client.sendText(resolvedLid, message, options),
      resolvedLid
    );
    return { result, usedRecipient: resolvedLid };
  } catch (retryError) {
    // Clear cache if the retry also failed
    clearCachedLid(session, phone);

    if (isLidRequiredError(retryError)) {
      throw new RecipientResolutionError(
        `WhatsApp still requires LID for ${contact} after resolution. ` +
          'The resolved LID may be stale or invalid.',
        'lid_required',
        contact
      );
    }

    throw retryError;
  }
}

// ── Internal Timeout Helper ──────────────────────────────────────────────────

async function withInternalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs
    );
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}
