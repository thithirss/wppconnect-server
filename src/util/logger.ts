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
import Transport from 'winston-transport';
import winston from 'winston';

// ─── In-memory Ring Buffer ───────────────────────────────────────────────────
// Keeps the last LOG_BUFFER_SIZE log entries in memory for Telegram alerts.
const LOG_BUFFER_SIZE = 200;
const logBuffer: string[] = [];

// ─── HTTP Log Buffer ────────────────────────────────────────────────────────
const httpLogBuffer: string[] = [];

export function addHttpLog(line: string) {
  const timestamp = new Date().toISOString();
  httpLogBuffer.push(`[${timestamp}] ${line}`);
  if (httpLogBuffer.length > LOG_BUFFER_SIZE) {
    httpLogBuffer.shift();
  }
}

export function getRecentHttpLogs(count = 50): string[] {
  return httpLogBuffer.slice(-count);
}

class MemoryRingBufferTransport extends Transport {
  constructor(opts?: Transport.TransportStreamOptions) {
    super(opts);
  }

  log(info: any, callback: () => void) {
    setImmediate(() => this.emit('logged', info));

    const { level, message, timestamp, stack } = info;
    const line = stack
      ? `[${timestamp}] ${level.toUpperCase()}: ${message} — ${stack}`
      : `[${timestamp}] ${level.toUpperCase()}: ${message}`;

    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_SIZE) {
      logBuffer.shift();
    }

    callback();
  }
}

/**
 * Returns a snapshot of the last N log entries stored in the ring buffer.
 * Useful for attaching context to Telegram critical failure alerts.
 */
export function getRecentLogs(count = 50): string[] {
  return logBuffer.slice(-count);
}

// Use JSON logging for log files
// Here winston.format.errors() just seem to work
// because there is no winston.format.simple()
const jsonLogFileFormat = winston.format.combine(
  winston.format.errors({ stack: true }),
  winston.format.timestamp(),
  winston.format.prettyPrint()
);

export function createLogger(options: any) {
  const log_level = options.level;
  // Create file loggers
  const logger = winston.createLogger({
    level: 'debug',
    format: jsonLogFileFormat,
  });

  // When running locally, write everything to the console
  // with proper stacktraces enabled
  if (options.logger.indexOf('console') > -1) {
    logger.add(
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.errors({ stack: true }),
          winston.format.colorize(),
          winston.format.printf(({ level, message, timestamp, stack }) => {
            if (stack) {
              // print log trace
              return `${level}: ${timestamp} ${message} - ${stack}`;
            }
            return `${level}: ${timestamp} ${message}`;
          })
        ),
      })
    );
  }
  if (options.logger.indexOf('file') > -1) {
    logger.add(
      new winston.transports.File({
        filename: './log/app.logg',
        level: log_level,
        maxsize: 10485760,
        maxFiles: 3,
      })
    );
  }

  // Always add in-memory ring buffer (silent, no level filter on buffer itself)
  logger.add(
    new MemoryRingBufferTransport({
      format: winston.format.combine(
        winston.format.errors({ stack: true }),
        winston.format.timestamp()
      ),
    })
  );

  return logger;
}
