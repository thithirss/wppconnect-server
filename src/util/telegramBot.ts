import api from 'axios';
import fs from 'fs';
import FormData from 'form-data';
import path from 'path';
import { Logger } from 'winston';

import config from '../config';
import { ServerOptions } from '../types/ServerOptions';
import { getRecentHttpLogs, getRecentLogs } from './logger';
import {
  cleanupSession,
  forceReconnect,
  getAllMonitorStates,
  getMonitorState,
} from './sessionMonitor';
import {
  clientsArray,
  deleteSessionOnArray,
  eventEmitter,
} from './sessionUtil';
import CreateSessionUtil from './createSessionUtil';

function esc(t: string) {
  return t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Pending conversation states: chatId → {action, data}
const pendingActions = new Map<number, { action: string; data: any }>();

export class WppTelegramBot {
  private token: string;
  private chatId: number;
  private offset = 0;
  private running = false;
  private opts: ServerOptions;
  private log: Logger;
  private BASE: string;

  constructor(token: string, chatId: string, opts: ServerOptions, log: Logger) {
    this.token = token;
    this.chatId = parseInt(chatId, 10);
    this.opts = opts;
    this.log = log;
    this.BASE = `https://api.telegram.org/bot${token}`;
  }

  start() {
    this.running = true;
    this.log.info('[Bot] Iniciado.');
    this.registerCommands().catch(() => {});
    this.poll();
  }

  stop() {
    this.running = false;
  }

  private async registerCommands() {
    const commands = [
      { command: 'status', description: '📊 Status de todas as sessões' },
      { command: 'iniciar', description: '▶️ Iniciar sessão — /iniciar nome' },
      {
        command: 'reconectar',
        description: '🔄 Reconectar — /reconectar nome',
      },
      { command: 'fechar', description: '⏹ Fechar navegador — /fechar nome' },
      { command: 'sair', description: '🚪 Sair do WhatsApp — /sair nome' },
      { command: 'limpar', description: '🗑 Limpar sessão — /limpar nome' },
      {
        command: 'resetar',
        description: '💥 Reset total — apaga TUDO e desconecta',
      },
      {
        command: 'codigo',
        description: '📱 Login p/ código — /codigo +55... [sessao]',
      },
      { command: 'qr', description: '📲 Ver QR Code — /qr nome' },
      { command: 'logs', description: '📋 Ver logs — /logs [N]' },
      { command: 'ajuda', description: '❓ Ajuda' },
    ];
    commands.splice(commands.length - 1, 0, {
      command: 'wipevolume',
      description: 'WIPE completo do volume persistente',
    });
    commands.splice(
      commands.length - 1,
      0,
      { command: 'http', description: 'HTTP/API logs e erros - /http [N]' },
      {
        command: 'httplogs',
        description: 'HTTP/API logs e erros - /httplogs [N]',
      }
    );

    await api
      .post(`${this.BASE}/setMyCommands`, { commands }, { timeout: 10000 })
      .catch(() => {});
    this.log.info('[Bot] Comandos registrados no Telegram.');
  }

  private async poll() {
    while (this.running) {
      try {
        const r = await api.get(`${this.BASE}/getUpdates`, {
          params: {
            offset: this.offset,
            timeout: 30,
            allowed_updates: ['message', 'callback_query'],
          },
          timeout: 35000,
        });
        for (const u of r.data.result || []) {
          this.offset = u.update_id + 1;
          this.handle(u).catch((e) => this.log.error('[Bot] handle error:', e));
        }
      } catch (e: any) {
        if (this.running) {
          await this.sleep(5000);
        }
      }
    }
  }

  private async handle(u: any) {
    if (u.message) await this.onMsg(u.message);
    else if (u.callback_query) await this.onCb(u.callback_query);
  }

  private ok(chatId: number) {
    return chatId === this.chatId;
  }

  private async onMsg(msg: any) {
    if (!this.ok(msg.chat.id)) return;
    const text = (msg.text || '').trim();

    // ── Conversation state: handle pending input ──────────────────────────
    const pending = pendingActions.get(msg.chat.id);
    if (pending && !text.startsWith('/')) {
      pendingActions.delete(msg.chat.id);
      if (pending.action === 'awaiting_phone') {
        return this.doPhoneLogin(msg.chat.id, text, pending.data?.session);
      }
      return;
    }

    const [cmd, ...args] = text.split(/\s+/);
    const c = cmd.toLowerCase();
    if (c === '/start' || c === '/ajuda' || c === '/help')
      return this.help(msg.chat.id);
    if (c === '/status') return this.allStatus(msg.chat.id);
    if (c === '/logs')
      return this.sendLogs(msg.chat.id, parseInt(args[0] || '80', 10));
    if (c === '/httplogs' || c === '/http')
      return this.sendHttpLogs(msg.chat.id, parseInt(args[0] || '80', 10));
    if (c === '/reconectar')
      return args[0]
        ? this.doReconnect(msg.chat.id, args[0])
        : this.pickSession(
            msg.chat.id,
            'reconnect',
            '🔄 Qual sessão reconectar?'
          );
    if (c === '/iniciar')
      return args[0]
        ? this.doStart(msg.chat.id, args[0])
        : this.pickSession(msg.chat.id, 'start', '▶️ Qual sessão iniciar?');
    if (c === '/fechar')
      return args[0]
        ? this.doClose(msg.chat.id, args[0])
        : this.pickSession(msg.chat.id, 'close', '⏹ Qual sessão fechar?');
    if (c === '/sair')
      return args[0]
        ? this.doLogout(msg.chat.id, args[0])
        : this.pickSession(
            msg.chat.id,
            'logout',
            '🚪 Qual sessão desconectar?'
          );
    if (c === '/limpar')
      return args[0]
        ? this.doClear(msg.chat.id, args[0])
        : this.pickSession(msg.chat.id, 'clear', '🗑 Qual sessão limpar?');
    if (c === '/qr')
      return args[0]
        ? this.doQR(msg.chat.id, args[0])
        : this.pickSession(msg.chat.id, 'qr', '📲 Ver QR de qual sessão?');
    if (c === '/codigo')
      return args[0]
        ? this.doPhoneLogin(msg.chat.id, args[0], args[1])
        : this.promptPhone(msg.chat.id, 'central');
    if (c === '/resetar') return this.confirmReset(msg.chat.id);
    if (c === '/wipevolume') return this.confirmVolumeWipe(msg.chat.id);
    return this.help(msg.chat.id);
  }

  /** Shows a session picker. If no sessions exist, shows guidance. */
  private async pickSession(chatId: number, action: string, prompt: string) {
    const states = getAllMonitorStates();
    const tokens = this.getTokenSessions();
    const all = Array.from(
      new Set([...states.map((s) => s.session), ...tokens])
    );

    if (!all.length)
      return this.send(
        chatId,
        '📭 Nenhuma sessão encontrada. Use /iniciar <nome> para criar.'
      );

    const buttons = all.map((s) => {
      const state = states.find((st) => st.session === s);
      const icon = !state
        ? '⚪'
        : state.isConnected
        ? '🟢'
        : state.isInCooldown
        ? '🔴'
        : '🟡';
      return [{ text: `${icon} ${s}`, callback_data: `${action}:${s}` }];
    });

    await this.kb(chatId, prompt, buttons);
  }

  private getTokenSessions(): string[] {
    try {
      const dir = path.join(process.cwd(), 'tokens');
      if (!fs.existsSync(dir)) return [];
      return fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.data.json'))
        .map((f) => f.replace('.data.json', ''));
    } catch {
      return [];
    }
  }

  private async onCb(cb: any) {
    if (!this.ok(cb.message.chat.id)) return;
    await this.answerCb(cb.id);
    const [action, session] = (cb.data || '').split(':');
    if (action === 'status') return this.allStatus(cb.message.chat.id);
    if (action === 'detail') return this.detail(cb.message.chat.id, session);
    if (action === 'reconnect')
      return this.doReconnect(cb.message.chat.id, session);
    if (action === 'start') return this.doStart(cb.message.chat.id, session);
    if (action === 'close') return this.doClose(cb.message.chat.id, session);
    if (action === 'logout') return this.doLogout(cb.message.chat.id, session);
    if (action === 'clear') return this.doClear(cb.message.chat.id, session);
    if (action === 'qr') return this.doQR(cb.message.chat.id, session);
    if (action === 'phone')
      return this.promptPhone(cb.message.chat.id, session || 'central');
    if (action === 'logs') return this.sendLogs(cb.message.chat.id, 80);
    if (action === 'httplogs') return this.sendHttpLogs(cb.message.chat.id, 80);
    if (action === 'confirm_reset')
      return this.doNuclearReset(cb.message.chat.id);
    if (action === 'confirm_wipe_volume')
      return this.doVolumeWipe(cb.message.chat.id);
  }

  // ── Commands ──────────────────────────────────────────────────────────────

  private async help(chatId: number) {
    const states = getAllMonitorStates();
    const central = states.find((s) => s.session === 'central');
    const centralIcon = !central
      ? '⚪'
      : central.isConnected
      ? '🟢'
      : central.isInCooldown
      ? '🔴'
      : '🟡';
    const centralStatus = !central
      ? 'não iniciada'
      : central.isConnected
      ? 'Conectada'
      : 'Desconectada';

    await this.kb(
      chatId,
      `🤖 <b>WPPConnect Bot</b> — Painel de Controle\n\n` +
        `Sessão principal: ${centralIcon} <b>central</b> — <i>${centralStatus}</i>\n\n` +
        `Toque em uma opção abaixo:`,
      [
        [{ text: '📊 Status das sessões', callback_data: 'status:' }],
        [
          { text: '🔄 Reconectar central', callback_data: 'reconnect:central' },
          { text: '▶️ Iniciar central', callback_data: 'start:central' },
        ],
        [
          { text: '📲 Ver QR Code', callback_data: 'qr:central' },
          { text: '📱 Login por código', callback_data: 'phone:central' },
        ],
        [
          { text: '⏹ Fechar sessão', callback_data: 'close:central' },
          { text: '🚪 Sair do WhatsApp', callback_data: 'logout:central' },
        ],
        [{ text: '🗑 Limpar dados central', callback_data: 'clear:central' }],
        [
          {
            text: '💥 Reset total (APAGA TUDO)',
            callback_data: 'confirm_reset:',
          },
        ],
        [
          { text: '📋 Ver logs', callback_data: 'logs:' },
          { text: '🌐 Ver logs HTTP', callback_data: 'httplogs:' },
        ],
      ]
    );
  }

  private async allStatus(chatId: number) {
    const states = getAllMonitorStates();
    if (!states.length) {
      return this.kb(chatId, '📭 Nenhuma sessão monitorada ainda.', [
        [{ text: '🔄 Atualizar', callback_data: 'status:' }],
      ]);
    }
    await this.send(
      chatId,
      `📊 <b>Sessões</b> — ${new Date().toLocaleTimeString('pt-BR')}`
    );
    for (const s of states) {
      const icon = s.isConnected ? '🟢' : s.isInCooldown ? '🔴' : '🟡';
      const last = s.lastConnectedAt
        ? new Date(s.lastConnectedAt).toLocaleTimeString('pt-BR')
        : 'nunca';
      await this.kb(
        chatId,
        `${icon} <b>${s.session}</b>  |  ${
          s.isConnected ? 'Conectado' : 'Desconectado'
        }\n` +
          `Watchdog: ${s.watchdogActive ? '✅' : '⭕'}  Retries: ${
            s.retryCount
          }\n` +
          `Última conexão: <code>${last}</code>` +
          (s.isInCooldown ? '\n⏸ Em cooldown' : ''),
        [
          [
            { text: '🔄 Reconectar', callback_data: `reconnect:${s.session}` },
            { text: '▶️ Iniciar', callback_data: `start:${s.session}` },
            { text: '📲 QR', callback_data: `qr:${s.session}` },
          ],
          [
            { text: '📱 Código', callback_data: `phone:${s.session}` },
            { text: '⏹ Fechar', callback_data: `close:${s.session}` },
            { text: '🚪 Sair', callback_data: `logout:${s.session}` },
          ],
          [
            { text: '🗑 Limpar dados', callback_data: `clear:${s.session}` },
            { text: '🔍 Detalhes', callback_data: `detail:${s.session}` },
          ],
        ]
      );
    }
  }

  private async detail(chatId: number, session: string) {
    const s = getMonitorState(session);
    if (!s)
      return this.send(
        chatId,
        `❌ Sessão <code>${session}</code> não encontrada.`
      );
    const fmt = (d: Date | null) =>
      d ? new Date(d).toLocaleString('pt-BR') : 'nunca';
    const icon = s.isConnected ? '🟢' : s.isInCooldown ? '🔴' : '🟡';
    await this.kb(
      chatId,
      `${icon} <b>${session}</b>\n\n` +
        `Status: <b>${s.isConnected ? 'Conectado' : 'Desconectado'}</b>\n` +
        `Watchdog: ${s.watchdogActive ? '✅ Ativo' : '⭕'}\n` +
        `Retries: ${s.retryCount} | Cooldown: ${
          s.isInCooldown ? '⚠️ Sim' : 'Não'
        }\n` +
        `Última conexão: <code>${fmt(s.lastConnectedAt)}</code>\n` +
        `Desconexão: <code>${fmt(s.lastDisconnectedAt)}</code>\n` +
        (s.lastDisconnectReason
          ? `Motivo: <code>${s.lastDisconnectReason}</code>`
          : ''),
      [
        [
          { text: '🔄 Reconectar', callback_data: `reconnect:${session}` },
          { text: '📲 QR', callback_data: `qr:${session}` },
        ],
        [
          { text: '📱 Código', callback_data: `phone:${session}` },
          { text: '🔙 Voltar', callback_data: 'status:' },
        ],
      ]
    );
  }

  private async sendHttpLogs(chatId: number, count: number) {
    const logs = getRecentHttpLogs(Math.min(count, 200));
    if (!logs.length)
      return this.send(chatId, '📭 Nenhum log HTTP disponível.');
    const content = logs.join('\n');
    if (content.length < 3500) {
      await this.send(
        chatId,
        `🌐 <b>Últimos ${logs.length} logs HTTP:</b>\n<pre>${esc(
          content.slice(-3000)
        )}</pre>`
      );
    } else {
      await this.doc(
        chatId,
        Buffer.from(content),
        `http_logs_${Date.now()}.txt`,
        `🌐 <b>${logs.length} logs HTTP</b>`
      );
    }
  }

  private async sendLogs(chatId: number, count: number) {
    const logs = getRecentLogs(Math.min(count, 200));
    if (!logs.length) return this.send(chatId, '📭 Nenhum log disponível.');
    const content = logs.join('\n');
    if (content.length < 3500) {
      await this.send(
        chatId,
        `📋 <b>Últimos ${logs.length} logs:</b>\n<pre>${esc(
          content.slice(-3000)
        )}</pre>`
      );
    } else {
      await this.doc(
        chatId,
        Buffer.from(content),
        `logs_${Date.now()}.txt`,
        `📋 <b>${logs.length} logs</b>`
      );
    }
  }

  // ── Session actions ───────────────────────────────────────────────────────

  private fakeReq(body: any = {}): any {
    return {
      serverOptions: this.opts,
      logger: this.log,
      io: { emit: () => {} },
      body,
    };
  }

  private async doStart(chatId: number, session: string) {
    await this.send(chatId, `▶️ Iniciando sessão <code>${session}</code>...`);
    const existing = (clientsArray as any)[session] as any;
    if (existing) {
      try {
        if (typeof existing.close === 'function') await existing.close();
      } catch (_) {}
      (clientsArray as any)[session] = undefined;
    }
    const util = new CreateSessionUtil();
    util.opendata(this.fakeReq(), session).catch((e) => {
      this.send(
        chatId,
        `❌ Erro ao iniciar: <code>${esc(String(e?.message || e))}</code>`
      );
    });
    await this.kb(
      chatId,
      `✅ Sessão <code>${session}</code> sendo iniciada.\nVocê receberá QR Code ou código via Telegram.`,
      [[{ text: '📊 Status', callback_data: 'status:' }]]
    );
  }

  private async doReconnect(chatId: number, session: string) {
    const util = new CreateSessionUtil();
    const reconnectFn = async () => {
      const cl = (clientsArray as any)[session] as any;
      if (cl) {
        try {
          if (typeof cl.close === 'function') await cl.close();
        } catch (_) {}
        (clientsArray as any)[session] = undefined;
      }
      await util.opendata(this.fakeReq(), session);
    };
    forceReconnect(
      session,
      this.opts,
      this.log,
      getRecentLogs(80),
      reconnectFn
    );
    await this.kb(
      chatId,
      `🔄 Reconexão agendada para <code>${session}</code>.`,
      [[{ text: '📊 Status', callback_data: 'status:' }]]
    );
  }

  private async doClose(chatId: number, session: string) {
    const cl = (clientsArray as any)[session] as any;
    if (!cl)
      return this.send(
        chatId,
        `❌ Sessão <code>${session}</code> não encontrada.`
      );
    try {
      if (typeof cl.close === 'function') await cl.close();
      (clientsArray as any)[session] = { status: null };
      await this.send(
        chatId,
        `⏹ Sessão <code>${session}</code> fechada. Token mantido — use /iniciar para reconectar.`
      );
    } catch (e: any) {
      await this.send(
        chatId,
        `❌ Erro ao fechar: <code>${esc(String(e?.message || e))}</code>`
      );
    }
  }

  private async doLogout(chatId: number, session: string) {
    const cl = (clientsArray as any)[session] as any;
    if (!cl)
      return this.send(
        chatId,
        `❌ Sessão <code>${session}</code> não encontrada.`
      );
    try {
      if (typeof cl.logout === 'function') await cl.logout();
      else if (typeof cl.close === 'function') await cl.close();
      deleteSessionOnArray(session);
      // Remove token files
      const tokenPath = path.join(
        process.cwd(),
        'tokens',
        `${session}.data.json`
      );
      if (fs.existsSync(tokenPath)) fs.rmSync(tokenPath, { force: true });
      await this.send(
        chatId,
        `🚪 Logout de <code>${session}</code> realizado.\nToken removido — precisará escanear QR ou usar código na próxima vez.`
      );
    } catch (e: any) {
      await this.send(
        chatId,
        `❌ Erro ao sair: <code>${esc(String(e?.message || e))}</code>`
      );
    }
  }

  private async doClear(chatId: number, session: string) {
    const cl = (clientsArray as any)[session] as any;
    try {
      if (cl) {
        try {
          if (typeof cl.close === 'function') await cl.close();
        } catch (_) {}
      }
      (clientsArray as any)[session] = undefined;

      const userDir = path.join(process.cwd(), 'userDataDir', session);
      const tokenFile = path.join(
        process.cwd(),
        'tokens',
        `${session}.data.json`
      );
      if (fs.existsSync(userDir))
        fs.rmSync(userDir, { recursive: true, force: true });
      if (fs.existsSync(tokenFile)) fs.rmSync(tokenFile, { force: true });

      await this.send(
        chatId,
        `🗑 Dados de <code>${session}</code> limpos.\nSessão encerrada e todos os arquivos removidos.\nUse /iniciar para começar do zero.`
      );
    } catch (e: any) {
      await this.send(
        chatId,
        `❌ Erro ao limpar: <code>${esc(String(e?.message || e))}</code>`
      );
    }
  }

  /** Shows a nuclear reset confirmation prompt. */
  private async confirmReset(chatId: number) {
    await this.kb(
      chatId,
      `💥 <b>Reset Total — tem certeza?</b>\n\n` +
        `Esta ação irá:\n` +
        `• Fechar <b>todas</b> as sessões ativas\n` +
        `• Apagar <b>todos</b> os tokens salvos\n` +
        `• Apagar <b>todos</b> os dados de usuário (userDataDir)\n\n` +
        `Após o reset você precisará reconectar via QR ou código de telefone.\n\n` +
        `⚠️ <i>Esta ação não pode ser desfeita.</i>`,
      [
        [{ text: '💥 Sim, apagar tudo', callback_data: 'confirm_reset:' }],
        [{ text: '❌ Cancelar', callback_data: 'status:' }],
      ]
    );
  }

  private async confirmVolumeWipe(chatId: number) {
    const volumePath = path.resolve(
      process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data'
    );
    await this.kb(
      chatId,
      `<b>WIPE DO VOLUME</b>\n\n` +
        `Todo o conteudo persistente de <code>${esc(
          volumePath
        )}</code> sera apagado.\n` +
        `Tokens, perfis e sessoes nao poderao ser recuperados.\n\n` +
        `O ponto de montagem sera preservado e as pastas necessarias serao recriadas.`,
      [
        [
          {
            text: 'Confirmar WIPE do volume',
            callback_data: 'confirm_wipe_volume:',
          },
        ],
        [{ text: 'Cancelar', callback_data: 'status:' }],
      ]
    );
  }

  private async doVolumeWipe(chatId: number) {
    const configuredPath = process.env.RAILWAY_VOLUME_MOUNT_PATH || '/data';
    const volumePath = path.resolve(configuredPath);
    const filesystemRoot = path.parse(volumePath).root;

    if (
      !path.isAbsolute(configuredPath) ||
      volumePath === filesystemRoot ||
      volumePath === path.resolve(process.cwd()) ||
      volumePath.length < 5 ||
      (!process.env.RAILWAY_VOLUME_MOUNT_PATH && volumePath !== '/data')
    ) {
      this.log.error(`[Bot] Refused unsafe volume wipe path: ${volumePath}`);
      return this.send(
        chatId,
        `Wipe recusado: caminho de volume inseguro <code>${esc(
          volumePath
        )}</code>.`
      );
    }

    await this.send(
      chatId,
      `<b>Wipe iniciado</b> em <code>${esc(volumePath)}</code>...`
    );

    try {
      for (const session of Object.keys(clientsArray)) {
        const client = (clientsArray as any)[session] as any;
        if (client && typeof client.close === 'function') {
          try {
            await Promise.race([
              Promise.resolve(client.close()),
              new Promise((resolve) => setTimeout(resolve, 5000)),
            ]);
          } catch (_) {}
        }
        (clientsArray as any)[session] = undefined;
        cleanupSession(session);
      }

      fs.mkdirSync(volumePath, { recursive: true });
      for (const entry of fs.readdirSync(volumePath)) {
        fs.rmSync(path.join(volumePath, entry), {
          recursive: true,
          force: true,
        });
      }

      fs.mkdirSync(path.join(volumePath, 'tokens'), { recursive: true });
      fs.mkdirSync(path.join(volumePath, 'userDataDir'), { recursive: true });
      this.log.warn(`[Bot] Persistent volume wiped: ${volumePath}`);

      await this.send(
        chatId,
        `<b>Volume limpo com sucesso.</b> A sessao central sera iniciada para um novo login.`
      );
      await this.doStart(chatId, 'central');
    } catch (error: any) {
      this.log.error('[Bot] Volume wipe failed:', error);
      await this.send(
        chatId,
        `Erro no wipe: <code>${esc(String(error?.message || error))}</code>`
      );
    }
  }

  /** Closes all sessions, deletes all tokens and userDataDir. No redeploy needed. */
  private async doNuclearReset(chatId: number) {
    await this.send(
      chatId,
      `💥 <b>Reset iniciado...</b>\n\nFechando sessões e apagando dados...`
    );

    let closed = 0;
    let errors = 0;

    // Close all active clients
    for (const key of Object.keys(clientsArray)) {
      const cl = (clientsArray as any)[key] as any;
      if (cl) {
        try {
          if (typeof cl.close === 'function') await cl.close();
        } catch (_) {}
        (clientsArray as any)[key] = undefined;
        closed++;
      }
    }

    // Delete tokens dir
    const tokensDir = path.join(process.cwd(), 'tokens');
    try {
      if (fs.existsSync(tokensDir)) {
        const files = fs
          .readdirSync(tokensDir)
          .filter((f) => f.endsWith('.data.json'));
        for (const f of files)
          fs.rmSync(path.join(tokensDir, f), { force: true });
        this.log.info(
          `[Bot] Nuclear reset: deleted ${files.length} token files.`
        );
      }
    } catch (e) {
      errors++;
      this.log.error('[Bot] Nuclear reset token error:', e);
    }

    // Delete userDataDir
    const udDir = path.join(process.cwd(), 'userDataDir');
    try {
      if (fs.existsSync(udDir)) {
        fs.rmSync(udDir, { recursive: true, force: true });
        this.log.info('[Bot] Nuclear reset: deleted userDataDir.');
      }
    } catch (e) {
      errors++;
      this.log.error('[Bot] Nuclear reset userDataDir error:', e);
    }

    await this.kb(
      chatId,
      `✅ <b>Reset concluído!</b>\n\n` +
        `• Sessões fechadas: <b>${closed}</b>\n` +
        `• Erros: <b>${errors}</b>\n\n` +
        `Agora use /iniciar + /codigo ou /qr para reconectar.`,
      [
        [{ text: '📱 Iniciar com código', callback_data: 'phone:' }],
        [{ text: '📊 Ver status', callback_data: 'status:' }],
      ]
    );

    // Automatically restart the central session so the QR code logic triggers
    await this.doStart(chatId, 'central');
  }

  private async doQR(chatId: number, session: string) {
    const cl = (clientsArray as any)[session] as any;
    if (!cl)
      return this.kb(
        chatId,
        `❌ Sessão <code>${session}</code> não encontrada.`,
        [[{ text: '▶️ Iniciar sessão', callback_data: `start:${session}` }]]
      );
    if (cl.status === 'CONNECTED')
      return this.send(
        chatId,
        `✅ Sessão <code>${session}</code> já está conectada!`
      );
    if (cl.qrcode) {
      const raw = cl.qrcode.replace('data:image/png;base64,', '');
      return this.photo(
        chatId,
        Buffer.from(raw, 'base64'),
        `📲 <b>QR Code — ${session}</b>\n\nEscaneie para conectar.`
      );
    }
    await this.kb(chatId, `⏳ QR não disponível. Inicie a sessão primeiro:`, [
      [{ text: '▶️ Iniciar', callback_data: `start:${session}` }],
    ]);
  }

  private async promptPhone(chatId: number, session: string) {
    // Always default to 'central' if no session specified
    const targetSession = session || 'central';
    pendingActions.set(chatId, {
      action: 'awaiting_phone',
      data: { session: targetSession },
    });
    await this.kb(
      chatId,
      `📱 <b>Login por código — sessão: central</b>\n\n` +
        `Digite o número de telefone da conta WhatsApp:\n\n` +
        `<code>+5531999999999</code>\n\n` +
        `📍 <i>No celular: WhatsApp → Config → Aparelhos conectados → Conectar aparelho → Vincular com número de telefone</i>`,
      [[{ text: '❌ Cancelar', callback_data: 'status:' }]]
    );
  }

  private async doPhoneLogin(
    chatId: number,
    phone: string,
    sessionArg?: string
  ) {
    const clean = phone.replace(/[^\d+]/g, '');
    if (!clean || clean.replace('+', '').length < 8) {
      return this.send(
        chatId,
        `❌ Número inválido. Use: <code>+5511999999999</code>`
      );
    }

    const session = sessionArg || 'central'; // always default to 'central'
    const digits = clean.replace('+', ''); // WPPConnect expects digits only

    await this.send(
      chatId,
      `📱 <b>Iniciando login via código...</b>\n\n` +
        `📞 Número: <code>${clean}</code>\n` +
        `🔑 Sessão: <code>${session}</code>\n\n` +
        `⏳ Aguarde — o código chegará em breve.\n\n` +
        `<i>Já abra no celular:\nWhatsApp → Configurações → Aparelhos conectados → Conectar aparelho → Vincular com número de telefone</i>`
    );

    // Register listeners BEFORE starting session
    const onCode = (code: string) => {
      this.log.info(`[Bot] Código recebido para ${session}: ${code}`);
      // Message 1: instructions
      this.kb(
        chatId,
        `🔑 <b>Código de vinculação pronto!</b>\n` +
          `Sessão: <code>${session}</code>\n` +
          `📍 WhatsApp → Aparelhos conectados → Conectar → Vincular por número de telefone\n` +
          `⏱ <i>Expira em ~2 minutos — copie a mensagem abaixo:</i>`,
        [[{ text: '📊 Ver status', callback_data: `detail:${session}` }]]
      ).catch(() => {});
      // Message 2: JUST the code (easy to copy)
      this.send(chatId, `<code>${code}</code>`).catch(() => {});
    };

    const onQr = (qrBase64: string) => {
      this.log.info(`[Bot] QR recebido como fallback para ${session}`);
      const raw = qrBase64.replace('data:image/png;base64,', '');
      this.photo(
        chatId,
        Buffer.from(raw, 'base64'),
        `📲 <b>QR Code (fallback) — ${session}</b>\n\nLogin por código não disponível, escaneie o QR.`
      ).catch(() => {});
    };

    eventEmitter.once(`phoneCode-${session}`, onCode);
    eventEmitter.once(`qrcode-${session}`, onQr);

    const timeout = setTimeout(() => {
      eventEmitter.off(`phoneCode-${session}`, onCode);
      eventEmitter.off(`qrcode-${session}`, onQr);
      this.send(
        chatId,
        `⏰ Timeout — nenhum código recebido para <code>${session}</code>.\nTente: <code>/codigo ${clean} ${session}</code>`
      ).catch(() => {});
    }, 3 * 60 * 1000);

    eventEmitter.once(`phoneCode-${session}`, () => clearTimeout(timeout));
    eventEmitter.once(`qrcode-${session}`, () => clearTimeout(timeout));

    // Close existing session if any
    const existing = (clientsArray as any)[session] as any;
    if (existing) {
      try {
        if (typeof existing.close === 'function') await existing.close();
      } catch (_) {}
      (clientsArray as any)[session] = undefined;
    }

    // Override autoClose to 0 (disabled) for phone login
    const optsOverride: any = {
      ...this.opts,
      createOptions: { ...(this.opts as any).createOptions, autoClose: 0 },
    };
    const req = {
      serverOptions: optsOverride,
      logger: this.log,
      io: { emit: () => {} },
      body: { phone: digits },
    };

    const util = new CreateSessionUtil();
    util.opendata(req as any, session).catch((e: any) => {
      clearTimeout(timeout);
      eventEmitter.off(`phoneCode-${session}`, onCode);
      eventEmitter.off(`qrcode-${session}`, onQr);
      this.log.error(`[Bot] Phone login error for ${session}:`, e?.message);
      this.send(
        chatId,
        `❌ Erro no login: <code>${esc(String(e?.message || e))}</code>`
      ).catch(() => {});
    });
  }

  // ── Telegram API ──────────────────────────────────────────────────────────

  async send(chatId: number, text: string) {
    await api
      .post(
        `${this.BASE}/sendMessage`,
        { chat_id: chatId, text, parse_mode: 'HTML' },
        { timeout: 10000 }
      )
      .catch((e) => this.log.warn('[Bot] send failed:', e?.message));
  }

  async kb(chatId: number, text: string, inline_keyboard: any[][]) {
    await api
      .post(
        `${this.BASE}/sendMessage`,
        {
          chat_id: chatId,
          text,
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard },
        },
        { timeout: 10000 }
      )
      .catch((e) => this.log.warn('[Bot] kb failed:', e?.message));
  }

  private async photo(chatId: number, buffer: Buffer, caption: string) {
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('photo', buffer, {
      filename: 'qr.png',
      contentType: 'image/png',
    });
    await api
      .post(`${this.BASE}/sendPhoto`, form, {
        headers: form.getHeaders(),
        timeout: 20000,
      })
      .catch((e) => this.log.warn('[Bot] photo failed:', e?.message));
  }

  private async doc(
    chatId: number,
    buffer: Buffer,
    filename: string,
    caption: string
  ) {
    const form = new FormData();
    form.append('chat_id', chatId.toString());
    form.append('caption', caption);
    form.append('parse_mode', 'HTML');
    form.append('document', buffer, { filename, contentType: 'text/plain' });
    await api
      .post(`${this.BASE}/sendDocument`, form, {
        headers: form.getHeaders(),
        timeout: 20000,
      })
      .catch((e) => this.log.warn('[Bot] doc failed:', e?.message));
  }

  private async answerCb(id: string) {
    await api
      .post(
        `${this.BASE}/answerCallbackQuery`,
        { callback_query_id: id },
        { timeout: 5000 }
      )
      .catch(() => {});
  }

  private sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
  }
}

let bot: WppTelegramBot | null = null;

export function startTelegramBot(
  opts: ServerOptions,
  log: Logger
): WppTelegramBot | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    log.info('[Bot] Telegram não configurado.');
    return null;
  }
  if (bot) return bot;
  bot = new WppTelegramBot(token, chatId, opts, log);
  bot.start();
  return bot;
}

export function stopTelegramBot() {
  bot?.stop();
  bot = null;
}
