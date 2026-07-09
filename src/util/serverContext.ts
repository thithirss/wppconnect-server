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
 * Global server context — makes serverOptions and logger available
 * outside of the Express request scope (e.g., in Telegram bot handlers).
 */

import { Logger } from 'winston';
import { ServerOptions } from '../types/ServerOptions';

let _serverOptions: ServerOptions | null = null;
let _logger: Logger | null = null;
let _io: any = null;

export function setServerContext(
  serverOptions: ServerOptions,
  logger: Logger,
  io: any
): void {
  _serverOptions = serverOptions;
  _logger = logger;
  _io = io;
}

export function getServerOptions(): ServerOptions {
  if (!_serverOptions) throw new Error('Server context not initialized yet.');
  return _serverOptions;
}

export function getLogger(): Logger {
  if (!_logger) throw new Error('Server context not initialized yet.');
  return _logger;
}

export function getIo(): any {
  return _io;
}
