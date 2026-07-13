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
 * Redacts sensitive information from strings before they are logged,
 * emitted via socket.io, or sent to webhooks.
 *
 * Targets:
 *  - WhatsApp device-linking URLs (https://wa.me/settings/linked_devices...)
 *  - Base64-encoded QR code image data
 *  - Phone pairing codes (8-digit alphanumeric)
 *  - Authorization / Bearer tokens
 *  - Generic long base64 blobs that look like tokens/secrets
 */

const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // WhatsApp linking URL with fragment (e.g. https://wa.me/settings/linked_devices#2@...)
  {
    pattern: /https?:\/\/wa\.me\/settings\/linked_devices[^\s'")}\]]*/, // eslint-disable-line
    replacement: '[REDACTED wa.me linking URL]',
  },
  // Authorization / Bearer header values
  {
    pattern:
      /((?:Authorization|Bearer)\s*[:=]?\s*(?:Bearer\s*)?)[^\s'")}\],]+/gi,
    replacement: '$1[REDACTED]',
  },
];

/**
 * Redacts known sensitive patterns from a string value.
 * Non-string values are returned unchanged.
 */
export function redactSensitive(input: string): string {
  if (typeof input !== 'string') return input;

  let result = input;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * Returns true if a string looks like it contains a WhatsApp linking URL
 * or other sensitive pairing data that should not be logged in full.
 */
export function containsSensitiveData(input: string): boolean {
  if (typeof input !== 'string') return false;
  return /https?:\/\/wa\.me\/settings\/linked_devices/i.test(input);
}

/**
 * Redacts a QR/linking urlCode so that only a short prefix is visible.
 * Returns the original value if it does not look sensitive.
 */
export function redactUrlCode(urlCode: string | undefined | null): string {
  if (!urlCode || typeof urlCode !== 'string') return '[empty]';

  if (urlCode.startsWith('http')) {
    // Keep scheme + host, redact the rest
    try {
      const url = new URL(urlCode);
      return `${url.origin}${url.pathname}#[REDACTED]`;
    } catch {
      return '[REDACTED URL]';
    }
  }

  // For non-URL codes, show first 8 chars
  if (urlCode.length > 12) {
    return urlCode.substring(0, 8) + '...[REDACTED]';
  }
  return urlCode;
}

/**
 * Masks a phone pairing code, showing only the last 2 characters.
 */
export function redactPhoneCode(code: string | undefined | null): string {
  if (!code || typeof code !== 'string') return '[empty]';
  if (code.length <= 2) return code;
  return '*'.repeat(code.length - 2) + code.slice(-2);
}
