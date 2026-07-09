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

import api from 'axios';
import FormData from 'form-data';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

function getTelegramConfig(): TelegramConfig | null {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!botToken || !chatId) {
    return null;
  }

  return { botToken, chatId };
}

function escapeMarkdown(text: string): string {
  return text.replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

/**
 * Sends a text message to Telegram. Uses MarkdownV2 format.
 */
export async function sendTelegramMessage(
  text: string,
  disableNotification = false
): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config) return false;

  try {
    await api.post(
      `https://api.telegram.org/bot${config.botToken}/sendMessage`,
      {
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        disable_notification: disableNotification,
      },
      { timeout: 10000 }
    );
    return true;
  } catch (e: any) {
    console.error('[TelegramNotifier] Failed to send message:', e?.message);
    return false;
  }
}

/**
 * Sends a photo (QR Code) to Telegram with a caption.
 */
export async function sendTelegramPhoto(
  photoBase64: string,
  caption: string
): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config) return false;

  try {
    const imageBuffer = Buffer.from(photoBase64, 'base64');
    const form = new FormData();
    form.append('chat_id', config.chatId);
    form.append('caption', caption);
    form.append('photo', imageBuffer, {
      filename: 'qrcode.png',
      contentType: 'image/png',
    });

    await api.post(
      `https://api.telegram.org/bot${config.botToken}/sendPhoto`,
      form,
      {
        headers: form.getHeaders(),
        timeout: 15000,
      }
    );
    return true;
  } catch (e: any) {
    console.error('[TelegramNotifier] Failed to send photo:', e?.message);
    return false;
  }
}

/**
 * Sends a document (log file) to Telegram.
 */
export async function sendTelegramDocument(
  content: string,
  filename: string,
  caption: string
): Promise<boolean> {
  const config = getTelegramConfig();
  if (!config) return false;

  try {
    const buffer = Buffer.from(content, 'utf-8');
    const form = new FormData();
    form.append('chat_id', config.chatId);
    form.append('caption', caption);
    form.append('document', buffer, {
      filename,
      contentType: 'text/plain',
    });

    await api.post(
      `https://api.telegram.org/bot${config.botToken}/sendDocument`,
      form,
      {
        headers: form.getHeaders(),
        timeout: 20000,
      }
    );
    return true;
  } catch (e: any) {
    console.error('[TelegramNotifier] Failed to send document:', e?.message);
    return false;
  }
}

// ─── Pre-formatted alert helpers ────────────────────────────────────────────

export async function notifyServerStarted(version: string): Promise<void> {
  const hostname =
    process.env.RAILWAY_SERVICE_NAME || process.env.HOSTNAME || 'local';
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });

  await sendTelegramMessage(
    `🟢 <b>WPPConnect Server iniciado</b>\n\n` +
      `🖥 Host: <code>${hostname}</code>\n` +
      `📦 Versão: <code>${version}</code>\n` +
      `🕐 Horário: <code>${now}</code>`
  );
}

export async function notifyHttpRequestProblem(details: {
  method: string;
  path: string;
  statusCode?: number;
  durationMs: number;
  reason: string;
  requestId?: string;
  session?: string;
  bodyPreview?: string;
}): Promise<void> {
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
  const status =
    details.statusCode == null ? 'sem resposta' : String(details.statusCode);
  const requestId = details.requestId
    ? `\nID: <code>${details.requestId}</code>`
    : '';
  const session = details.session
    ? `\nSessao: <code>${details.session}</code>`
    : '';
  const body = details.bodyPreview
    ? `\nBody: <code>${details.bodyPreview
        .substring(0, 300)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</code>`
    : '';

  await sendTelegramMessage(
    `<b>Alerta HTTP/API</b>\n\n` +
      `Rota: <code>${details.method} ${details.path}</code>\n` +
      `Status: <code>${status}</code>\n` +
      `Duracao: <code>${details.durationMs}ms</code>\n` +
      `Motivo: <code>${details.reason
        .substring(0, 200)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</code>${requestId}${session}${body}\n` +
      `Horario: <code>${now}</code>\n\n` +
      `<i>Use /http no bot para ver os logs HTTP/API recentes.</i>`
  );
}

export async function notifySessionConnected(session: string): Promise<void> {
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
  await sendTelegramMessage(
    `✅ <b>Sessão reconectada!</b>\n\n` +
      `📱 Sessão: <code>${session}</code>\n` +
      `🕐 Horário: <code>${now}</code>`
  );
}

export async function notifySessionDisconnected(
  session: string,
  reason: string,
  attempt: number,
  maxRetries: number
): Promise<void> {
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
  await sendTelegramMessage(
    `⚠️ <b>Sessão desconectada</b>\n\n` +
      `📱 Sessão: <code>${session}</code>\n` +
      `📋 Motivo: <code>${reason}</code>\n` +
      `🔄 Tentativa de reconexão: <b>${attempt}/${maxRetries}</b>\n` +
      `🕐 Horário: <code>${now}</code>`
  );
}

export async function notifyQRCodeRequired(
  session: string,
  qrBase64: string,
  attempt: number
): Promise<void> {
  const caption =
    `📲 <b>QR Code necessário</b>\n\n` +
    `📱 Sessão: <code>${session}</code>\n` +
    `🔢 Tentativa: <code>${attempt}</code>\n\n` +
    `Escaneie o QR Code para reconectar o WhatsApp.`;

  await sendTelegramPhoto(qrBase64, caption);
}

export async function notifyCriticalFailure(
  session: string,
  maxRetries: number,
  recentLogs: string[]
): Promise<void> {
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });

  await sendTelegramMessage(
    `🚨 <b>FALHA CRÍTICA — Intervenção necessária!</b>\n\n` +
      `📱 Sessão: <code>${session}</code>\n` +
      `❌ Todas as <b>${maxRetries}</b> tentativas de reconexão falharam\n` +
      `🕐 Horário: <code>${now}</code>\n\n` +
      `⚡ Acesse o painel de administração para escanear o QR Code e reconectar.\n` +
      `📊 Os logs recentes serão enviados a seguir.`,
    false
  );

  if (recentLogs.length > 0) {
    const logContent = recentLogs.join('\n');
    await sendTelegramDocument(
      logContent,
      `wpp_error_${session}_${Date.now()}.txt`,
      `📋 Logs recentes — sessão <code>${session}</code>`
    );
  }
}

export async function notifyReconnectAttempt(
  session: string,
  attempt: number,
  maxRetries: number,
  waitSeconds: number
): Promise<void> {
  await sendTelegramMessage(
    `🔄 <b>Tentando reconectar...</b>\n\n` +
      `📱 Sessão: <code>${session}</code>\n` +
      `🔢 Tentativa: <b>${attempt}/${maxRetries}</b>\n` +
      `⏱ Aguardando: <code>${waitSeconds}s</code>`,
    true // silent notification for retry attempts
  );
}

export function isTelegramConfigured(): boolean {
  return getTelegramConfig() !== null;
}

/**
 * Called when any message fails to send. Sends a full diagnostic alert to Telegram.
 */
export async function notifyMessageFailed(
  session: string,
  phone: string,
  messagePreview: string | undefined,
  errorMessage: string,
  statusCode: number | string
): Promise<void> {
  const now = new Date().toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
  });
  const preview = messagePreview
    ? `\n📝 Mensagem: <code>${messagePreview
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}${
        messagePreview.length >= 80 ? '...' : ''
      }</code>`
    : '';

  await sendTelegramMessage(
    `❌ <b>Falha ao enviar mensagem WhatsApp</b>\n\n` +
      `📱 Sessão: <code>${session}</code>\n` +
      `📞 Destinatário: <code>${phone}</code>${preview}\n` +
      `🔴 Código HTTP: <code>${statusCode}</code>\n` +
      `💬 Erro: <code>${errorMessage
        .substring(0, 300)
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')}</code>\n` +
      `🕐 Horário: <code>${now}</code>\n\n` +
      `<i>Use /status no bot para verificar a conexão.</i>`
  );
}
