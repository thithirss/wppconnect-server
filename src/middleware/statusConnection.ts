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

import { NextFunction, Request, Response } from 'express';

import { contactToArray } from '../util/functions';

const envBool = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  let timer: NodeJS.Timeout;
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

export default async function statusConnection(
  req: Request,
  res: Response,
  next: NextFunction
) {
  try {
    if (!req.client || !req.client.isConnected) {
      return res.status(404).json({
        response: null,
        status: 'Disconnected',
        reason: 'session_not_found',
        message: 'A sessao do WhatsApp nao foi iniciada neste processo.',
      });
    }

    const connectionTimeoutMs = parseInt(
      process.env.WPP_CONNECTION_CHECK_TIMEOUT_MS || '15000',
      10
    );
    const numberStatusTimeoutMs = parseInt(
      process.env.WPP_NUMBER_STATUS_TIMEOUT_MS || '12000',
      10
    );
    const validateNumberStatus = envBool('WPP_VALIDATE_NUMBER_STATUS', true);
    const verifyConnected = envBool('WPP_VERIFY_CONNECTED_BEFORE_SEND', false);

    if (req.client.status !== 'CONNECTED') {
      return res.status(503).json({
        response: null,
        status: 'Disconnected',
        reason: 'session_not_connected',
        message: `A sessao do WhatsApp existe, mas ainda esta em status ${req.client.status}.`,
      });
    }

    if (verifyConnected) {
      const isConnected = await withTimeout(
        req.client.isConnected(),
        connectionTimeoutMs,
        'isConnected'
      );

      if (!isConnected) {
        return res.status(503).json({
          response: null,
          status: 'Disconnected',
          reason: 'session_not_connected',
          message: 'A sessao do WhatsApp existe, mas nao esta conectada.',
        });
      }
    }

    const numbers: any[] = [];
    const localArr = contactToArray(
      req.body.phone || [],
      req.body.isGroup,
      req.body.isNewsletter,
      req.body.isLid
    );

    let index = 0;
    for (const contact of localArr) {
      if (req.body.isGroup || req.body.isNewsletter || !validateNumberStatus) {
        localArr[index] = contact;
      } else if (numbers.indexOf(contact) < 0) {
        req.logger.debug(`Checking WhatsApp number status: ${contact}`);
        const profile: any = await withTimeout(
          req.client.checkNumberStatus(contact),
          numberStatusTimeoutMs,
          `checkNumberStatus ${contact}`
        ).catch((error) => {
          req.logger.warn(error);
          return null;
        });

        if (!profile?.numberExists) {
          const num = (contact as any).split('@')[0];
          return res.status(400).json({
            response: null,
            status: 'Connected',
            message: `O numero ${num} nao existe ou nao respondeu a validacao a tempo.`,
          });
        }

        if (numbers.indexOf(profile.id._serialized) < 0) {
          numbers.push(profile.id._serialized);
        }
        localArr[index] = profile.id._serialized;
      }
      index++;
    }

    req.body.phone = localArr;
    return next();
  } catch (error) {
    req.logger.error(error);
    const message = error instanceof Error ? error.message : String(error);
    const isTimeout = message.includes('timed out');
    return res.status(isTimeout ? 503 : 404).json({
      response: null,
      status: 'Disconnected',
      reason: isTimeout ? 'session_check_timeout' : 'session_check_failed',
      message: isTimeout
        ? 'A sessao do WhatsApp nao respondeu ao teste de conexao a tempo.'
        : 'A sessao do WhatsApp nao esta ativa.',
      error: message,
    });
  }
}
