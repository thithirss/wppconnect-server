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

import { Logger } from 'winston';

import { ServerOptions } from '../types/ServerOptions';
import {
  isTelegramConfigured,
  notifyCriticalFailure,
  notifyReconnectAttempt,
  notifySessionConnected,
  notifySessionDisconnected,
} from './telegramNotifier';

export interface SessionMonitorState {
  session: string;
  isConnected: boolean;
  retryCount: number;
  lastConnectedAt: Date | null;
  lastDisconnectedAt: Date | null;
  lastReconnectAttemptAt: Date | null;
  lastDisconnectReason: string | null;
  isInCooldown: boolean;
  cooldownUntil: Date | null;
  watchdogActive: boolean;
}

const monitorStates = new Map<string, SessionMonitorState>();
const watchdogTimers = new Map<string, NodeJS.Timeout>();
const reconnectTimers = new Map<string, NodeJS.Timeout>();

const DEFAULT_PING_INTERVAL_MS = parseInt(
  process.env.MONITOR_PING_INTERVAL_MS || '120000',
  10
);
const DEFAULT_MAX_RETRIES = parseInt(
  process.env.MONITOR_MAX_RETRIES || '5',
  10
);
const DEFAULT_RETRY_BACKOFF_MS = parseInt(
  process.env.MONITOR_RETRY_BACKOFF_MS || '30000',
  10
);
const COOLDOWN_AFTER_MAX_RETRIES_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Calculates exponential backoff delay.
 * attempt=1 → baseMs, attempt=2 → 2×baseMs, attempt=3 → 4×baseMs ...
 */
function getBackoffDelay(attempt: number, baseMs: number): number {
  const delay = baseMs * Math.pow(2, attempt - 1);
  // Cap at 5 minutes
  return Math.min(delay, 5 * 60 * 1000);
}

function getOrCreateState(session: string): SessionMonitorState {
  if (!monitorStates.has(session)) {
    monitorStates.set(session, {
      session,
      isConnected: false,
      retryCount: 0,
      lastConnectedAt: null,
      lastDisconnectedAt: null,
      lastReconnectAttemptAt: null,
      lastDisconnectReason: null,
      isInCooldown: false,
      cooldownUntil: null,
      watchdogActive: false,
    });
  }
  return monitorStates.get(session)!;
}

/**
 * Called when a session successfully connects.
 * Resets retry counters and starts the watchdog.
 */
export function onSessionConnected(
  session: string,
  client: any,
  serverOptions: ServerOptions,
  logger: Logger,
  isReconnect = false
): void {
  const state = getOrCreateState(session);
  const wasDisconnected = !state.isConnected || isReconnect;

  state.isConnected = true;
  state.lastConnectedAt = new Date();
  state.retryCount = 0;
  state.isInCooldown = false;
  state.cooldownUntil = null;

  // Cancel any pending reconnect timer
  if (reconnectTimers.has(session)) {
    clearTimeout(reconnectTimers.get(session)!);
    reconnectTimers.delete(session);
  }

  if (wasDisconnected && isReconnect) {
    logger.info(
      `[SessionMonitor] Session ${session} reconnected successfully.`
    );
    if (isTelegramConfigured()) {
      notifySessionConnected(session).catch(() => {});
    }
  }

  // Start the watchdog
  startWatchdog(session, client, serverOptions, logger);
}

/**
 * Called when a session disconnects.
 * Triggers the auto-reconnect logic.
 */
export function onSessionDisconnected(
  session: string,
  reason: string,
  serverOptions: ServerOptions,
  logger: Logger,
  recentLogs: string[],
  reconnectFn: () => Promise<void>
): void {
  const state = getOrCreateState(session);
  state.isConnected = false;
  state.lastDisconnectedAt = new Date();
  state.lastDisconnectReason = reason;

  // Stop watchdog since we're already disconnected
  stopWatchdog(session);

  // Cancel any pending reconnect that may still be queued
  if (reconnectTimers.has(session)) {
    clearTimeout(reconnectTimers.get(session)!);
    reconnectTimers.delete(session);
  }

  if (
    state.isInCooldown &&
    state.cooldownUntil &&
    state.cooldownUntil > new Date()
  ) {
    logger.warn(
      `[SessionMonitor] Session ${session} is in cooldown until ${state.cooldownUntil.toISOString()}. Skipping reconnect.`
    );
    return;
  }

  const maxRetries = DEFAULT_MAX_RETRIES;

  logger.warn(
    `[SessionMonitor] Session ${session} disconnected (${reason}). Scheduling reconnect attempt ${
      state.retryCount + 1
    }/${maxRetries}.`
  );

  if (isTelegramConfigured()) {
    notifySessionDisconnected(
      session,
      reason,
      state.retryCount + 1,
      maxRetries
    ).catch(() => {});
  }

  scheduleReconnect(session, serverOptions, logger, recentLogs, reconnectFn);
}

function scheduleReconnect(
  session: string,
  serverOptions: ServerOptions,
  logger: Logger,
  recentLogs: string[],
  reconnectFn: () => Promise<void>
): void {
  const state = getOrCreateState(session);
  const maxRetries = DEFAULT_MAX_RETRIES;

  if (state.retryCount >= maxRetries) {
    logger.error(
      `[SessionMonitor] Session ${session} has exhausted all ${maxRetries} reconnect attempts. Entering cooldown.`
    );

    state.isInCooldown = true;
    state.cooldownUntil = new Date(Date.now() + COOLDOWN_AFTER_MAX_RETRIES_MS);

    if (isTelegramConfigured()) {
      notifyCriticalFailure(session, maxRetries, recentLogs).catch(() => {});
    }

    // After cooldown, reset counters so user can try reconnecting manually
    setTimeout(() => {
      const s = monitorStates.get(session);
      if (s) {
        s.isInCooldown = false;
        s.cooldownUntil = null;
        s.retryCount = 0;
        logger.info(
          `[SessionMonitor] Session ${session} cooldown expired. Retry counter reset.`
        );
      }
    }, COOLDOWN_AFTER_MAX_RETRIES_MS);

    return;
  }

  state.retryCount++;
  state.lastReconnectAttemptAt = new Date();

  const delayMs = getBackoffDelay(state.retryCount, DEFAULT_RETRY_BACKOFF_MS);
  const delaySec = Math.round(delayMs / 1000);

  logger.info(
    `[SessionMonitor] Scheduling reconnect for ${session} in ${delaySec}s (attempt ${state.retryCount}/${maxRetries}).`
  );

  if (isTelegramConfigured() && state.retryCount > 1) {
    notifyReconnectAttempt(
      session,
      state.retryCount,
      maxRetries,
      delaySec
    ).catch(() => {});
  }

  const timer = setTimeout(async () => {
    reconnectTimers.delete(session);
    logger.info(
      `[SessionMonitor] Executing reconnect attempt ${state.retryCount}/${maxRetries} for session ${session}.`
    );
    try {
      await reconnectFn();
    } catch (e) {
      logger.error(
        `[SessionMonitor] Reconnect attempt failed for ${session}:`,
        e
      );
      // If reconnectFn throws, schedule next attempt
      scheduleReconnect(
        session,
        serverOptions,
        logger,
        recentLogs,
        reconnectFn
      );
    }
  }, delayMs);

  reconnectTimers.set(session, timer);
}

/**
 * Starts the watchdog for a connected session.
 * Periodically pings the session to detect silent disconnections.
 */
function startWatchdog(
  session: string,
  client: any,
  serverOptions: ServerOptions,
  logger: Logger
): void {
  // Clear existing watchdog first
  stopWatchdog(session);

  const state = getOrCreateState(session);
  state.watchdogActive = true;

  const interval = setInterval(async () => {
    const currentState = monitorStates.get(session);
    if (!currentState?.isConnected) {
      stopWatchdog(session);
      return;
    }

    try {
      const isConnected = await client.isConnected();
      if (!isConnected) {
        logger.warn(
          `[SessionMonitor] Watchdog detected ${session} is not connected. Triggering reconnect.`
        );
        currentState.isConnected = false;
        stopWatchdog(session);

        // We don't have recentLogs or reconnectFn at this point, so we just flag it
        if (isTelegramConfigured()) {
          notifySessionDisconnected(
            session,
            'watchdog_detected',
            currentState.retryCount + 1,
            DEFAULT_MAX_RETRIES
          ).catch(() => {});
        }
      } else {
        logger.debug(`[SessionMonitor] Watchdog: ${session} is alive.`);
      }
    } catch (e) {
      logger.warn(`[SessionMonitor] Watchdog ping failed for ${session}:`, e);
    }
  }, DEFAULT_PING_INTERVAL_MS);

  watchdogTimers.set(session, interval);
  logger.info(
    `[SessionMonitor] Watchdog started for ${session} (interval: ${
      DEFAULT_PING_INTERVAL_MS / 1000
    }s).`
  );
}

function stopWatchdog(session: string): void {
  if (watchdogTimers.has(session)) {
    clearInterval(watchdogTimers.get(session)!);
    watchdogTimers.delete(session);
  }

  const state = monitorStates.get(session);
  if (state) {
    state.watchdogActive = false;
  }
}

/**
 * Force-triggers a reconnect for a session (for the manual reconnect API endpoint).
 */
export function forceReconnect(
  session: string,
  serverOptions: ServerOptions,
  logger: Logger,
  recentLogs: string[],
  reconnectFn: () => Promise<void>
): void {
  const state = getOrCreateState(session);

  // Reset cooldown and retry count for manual reconnect
  state.isInCooldown = false;
  state.cooldownUntil = null;
  state.retryCount = 0;
  state.isConnected = false;

  stopWatchdog(session);

  // Cancel pending auto-reconnect
  if (reconnectTimers.has(session)) {
    clearTimeout(reconnectTimers.get(session)!);
    reconnectTimers.delete(session);
  }

  logger.info(
    `[SessionMonitor] Manual reconnect triggered for session ${session}.`
  );
  scheduleReconnect(session, serverOptions, logger, recentLogs, reconnectFn);
}

/**
 * Returns the current monitor state for all sessions (for the status API endpoint).
 */
export function getAllMonitorStates(): SessionMonitorState[] {
  return Array.from(monitorStates.values());
}

export function getMonitorState(
  session: string
): SessionMonitorState | undefined {
  return monitorStates.get(session);
}

export function cleanupSession(session: string): void {
  stopWatchdog(session);

  if (reconnectTimers.has(session)) {
    clearTimeout(reconnectTimers.get(session)!);
    reconnectTimers.delete(session);
  }

  monitorStates.delete(session);
}
