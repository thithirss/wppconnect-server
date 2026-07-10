import { ServerOptions } from './types/ServerOptions';

const envBool = (name: string, fallback: boolean): boolean => {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const envList = (name: string, fallback: string[]): string[] => {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
};

// Telegram and monitor config are read from env vars at runtime.
// See src/util/telegramNotifier.ts and src/util/sessionMonitor.ts.
export default {
  secretKey: 'batatafritacomqueijo',
  host:
    process.env.WPP_HOST ||
    process.env.RAILWAY_PUBLIC_DOMAIN?.replace(/^/, 'https://') ||
    'http://localhost',
  port: parseInt(process.env.PORT || process.env.WPP_PORT || '21465', 10),
  deviceName: process.env.WPP_DEVICE_NAME || 'WppConnect',
  poweredBy: process.env.WPP_POWERED_BY || 'WPPConnect-Server',
  startAllSession: envBool('WPP_START_ALL_SESSION', true),
  tokenStoreType: process.env.WPP_TOKEN_STORE_TYPE || 'file',
  maxListeners: parseInt(process.env.WPP_MAX_LISTENERS || '15', 10),
  customUserDataDir: process.env.WPP_CUSTOM_USER_DATA_DIR || './userDataDir/',
  webhook: {
    url: process.env.WPP_WEBHOOK_URL || null,
    autoDownload: envBool('WPP_WEBHOOK_AUTO_DOWNLOAD', true),
    uploadS3: envBool('WPP_WEBHOOK_UPLOAD_S3', false),
    readMessage: envBool('WPP_WEBHOOK_READ_MESSAGE', true),
    allUnreadOnStart: envBool('WPP_WEBHOOK_ALL_UNREAD_ON_START', false),
    listenAcks: envBool('WPP_WEBHOOK_LISTEN_ACKS', true),
    onPresenceChanged: envBool('WPP_WEBHOOK_ON_PRESENCE_CHANGED', true),
    onParticipantsChanged: envBool('WPP_WEBHOOK_ON_PARTICIPANTS_CHANGED', true),
    onReactionMessage: envBool('WPP_WEBHOOK_ON_REACTION_MESSAGE', true),
    onPollResponse: envBool('WPP_WEBHOOK_ON_POLL_RESPONSE', true),
    onRevokedMessage: envBool('WPP_WEBHOOK_ON_REVOKED_MESSAGE', true),
    onLabelUpdated: envBool('WPP_WEBHOOK_ON_LABEL_UPDATED', true),
    onSelfMessage: envBool('WPP_WEBHOOK_ON_SELF_MESSAGE', false),
    ignore: envList('WPP_WEBHOOK_IGNORE', ['status@broadcast']),
  },
  websocket: {
    autoDownload: envBool('WPP_WEBSOCKET_AUTO_DOWNLOAD', false),
    uploadS3: envBool('WPP_WEBSOCKET_UPLOAD_S3', false),
  },
  chatwoot: {
    sendQrCode: true,
    sendStatus: true,
  },
  archive: {
    enable: false,
    waitTime: 10,
    daysToArchive: 45,
  },
  log: {
    level: process.env.WPP_LOG_LEVEL || 'silly',
    logger: envList('WPP_LOGGER', [
      'console',
      ...(envBool('WPP_LOG_TO_FILE', true) ? ['file'] : []),
    ]),
  },
  createOptions: {
    puppeteerOptions: {
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      // CDP calls can take longer on constrained Railway containers. This is
      // deliberately higher than the HTTP send timeout; the watchdog handles
      // an actually wedged page and recycles the session.
      protocolTimeout: parseInt(
        process.env.WPP_PUPPETEER_PROTOCOL_TIMEOUT_MS || '120000',
        10
      ),
    },
    browserArgs: [
      '--disable-web-security',
      '--no-sandbox',
      '--disable-background-networking',
      '--disable-default-apps',
      '--disable-extensions',
      '--disable-sync',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-translate',
      '--hide-scrollbars',
      '--metrics-recording-only',
      '--mute-audio',
      '--no-first-run',
      '--safebrowsing-disable-auto-update',
      '--ignore-certificate-errors',
      '--ignore-ssl-errors',
      '--ignore-certificate-errors-spki-list',
    ],
    /**
     * Example of configuring the linkPreview generator
     * If you set this to 'null', it will use global servers; however, you have the option to define your own server
     * Clone the repository https://github.com/wppconnect-team/wa-js-api-server and host it on your server with ssl
     *
     * Configure the attribute as follows:
     * linkPreviewApiServers: [ 'https://www.yourserver.com/wa-js-api-server' ]
     */
    linkPreviewApiServers: null,

    /**
     * Disable waiting for complete login (bypasses syncing wait)
     */
    waitForLogin: false,

    /**
     * Disable welcome message to speed up initialization
     */
    disableWelcome: true,

    /**
     * Set specific whatsapp version
     */
    // whatsappVersion: '2.xxxxx',
  },
  mapper: {
    enable: false,
    prefix: 'tagone-',
  },
  db: {
    mongodbDatabase: 'tokens',
    mongodbCollection: '',
    mongodbUser: '',
    mongodbPassword: '',
    mongodbHost: '',
    mongoIsRemote: true,
    mongoURLRemote: '',
    mongodbPort: 27017,
    redisHost: 'localhost',
    redisPort: 6379,
    redisPassword: '',
    redisDb: 0,
    redisPrefix: 'docker',
  },
  aws_s3: {
    region: 'sa-east-1' as any,
    access_key_id: null,
    secret_key: null,
    defaultBucketName: null,
    endpoint: null,
    forcePathStyle: null,
  },
  // ── Telegram Notifier (configure via env vars on Railway) ──────────────────
  // TELEGRAM_BOT_TOKEN  → token do bot criado no @BotFather
  // TELEGRAM_CHAT_ID    → ID do chat/grupo para receber alertas
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || null,
    chatId: process.env.TELEGRAM_CHAT_ID || null,
  },
  // ── Session Monitor ────────────────────────────────────────────────────────
  // MONITOR_PING_INTERVAL_MS   → intervalo do watchdog (padrão: 120000ms = 2min)
  // MONITOR_MAX_RETRIES        → tentativas máximas de reconexão (padrão: 5)
  // MONITOR_RETRY_BACKOFF_MS   → base do backoff exponencial (padrão: 30000ms)
  monitor: {
    pingIntervalMs: parseInt(
      process.env.MONITOR_PING_INTERVAL_MS || '120000',
      10
    ),
    maxRetries: parseInt(process.env.MONITOR_MAX_RETRIES || '5', 10),
    retryBackoffMs: parseInt(
      process.env.MONITOR_RETRY_BACKOFF_MS || '30000',
      10
    ),
  },
} as unknown as ServerOptions;
