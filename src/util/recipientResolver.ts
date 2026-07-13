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

// ── LID Resolution & Send Fallback ───────────────────────────────────────────

/**
 * Sends a text message with automatic LID/Crypto fallback.
 *
 * Flow:
 *  1. Try sending directly using the normalized @c.us JID.
 *  2. If WhatsApp Web throws "No LID for user" or rejects it (ack=-1) due to missing
 *     crypto keys/sync, we intercept the error.
 *  3. We force a network sync by calling `checkNumberStatus`. This tells the WhatsApp
 *     server to send the LID mapping and Signal keys to our local IndexedDB store.
 *  4. We retry the send using the exact JID returned by `checkNumberStatus`.
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
  const doAssert = assertResult || ((r: unknown) => r);

  // ── Try sending natively first ────────────────────────────────────────
  try {
    logger.info(`[sendMessage] Normalized recipient: ${contact}`);
    const result = doAssert(
      await client.sendText(contact, message, options),
      contact
    );
    return { result, usedRecipient: contact };
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : String(error || '');

    // Check if the error is a LID missing error or an encryption rejection (ack=-1)
    const isCryptoRejection =
      errorMessage.includes('ack=-1') ||
      errorMessage.includes('ACK_ERROR') ||
      errorMessage.includes('rejected message');

    if (!isLidRequiredError(error) && !isCryptoRejection) {
      throw error; // Bubble up unknown errors (e.g., disconnected session)
    }

    logger.info(
      `[sendMessage] Send failed (${
        isCryptoRejection ? 'Crypto/Ack Rejection' : 'LID Required'
      }) for ${contact}. Forcing network sync.`
    );
  }

  // ── Force network sync (usync) and retry once ─────────────────────────
  logger.info(
    `[sendMessage] Forcing usync via checkNumberStatus for ${contact}.`
  );
  let validJid = contact;

  try {
    const profile = await withInternalTimeout(
      client.checkNumberStatus(contact),
      15000,
      `checkNumberStatus ${contact}`
    );

    if (profile?.numberExists) {
      // If checkNumberStatus returned a @c.us, it might have corrected the 9th digit.
      // If it returned a @lid, we CANNOT send directly to @lid (WhatsApp server rejects with ack=-1).
      // In that case, we stick to the original contact (@c.us), because checkNumberStatus
      // already populated the internal IndexedDB store with the correct LID keys!
      if (
        profile.id &&
        profile.id._serialized &&
        !profile.id._serialized.endsWith('@lid')
      ) {
        validJid = profile.id._serialized;
      } else {
        validJid = contact;
      }
      logger.info(
        `[sendMessage] Sync complete. Will retry sending to JID: ${validJid}`
      );
    } else {
      throw new RecipientResolutionError(
        `WhatsApp checkNumberStatus indicates ${contact} does not exist on WhatsApp.`,
        'no_whatsapp',
        contact
      );
    }
  } catch (syncError: any) {
    if (syncError instanceof RecipientResolutionError) throw syncError;
    logger.warn(`[sendMessage] checkNumberStatus failed: ${syncError.message}`);
    // If it failed due to timeout, we will still try to retry sending to the original contact
  }

  logger.info(`[sendMessage] Retrying send to ${validJid} after sync.`);

  try {
    const result = doAssert(
      await client.sendText(validJid, message, options),
      validJid
    );
    return { result, usedRecipient: validJid };
  } catch (retryError) {
    const msg =
      retryError instanceof Error ? retryError.message : String(retryError);
    throw new RecipientResolutionError(
      `WhatsApp rejected message to ${validJid} even after forcing sync. Error: ${msg}`,
      'send_failed',
      validJid
    );
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
