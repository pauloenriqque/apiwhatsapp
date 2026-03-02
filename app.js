"use strict";

/**
 * app.js — BOT-ZDG (WhatsApp Web JS + RemoteAuth + MongoStore)
 *
 * Requisitos de ambiente:
 *  - MONGODB_URI: string SRV do MongoDB Atlas (ex.: mongodb+srv://user:pass@cluster/db?opts)
 *
 * Notas importantes:
 *  - RemoteAuth salva/restaura a sessão no Mongo (ideal para hosts com FS efêmero como Render Free).
 *  - Aguarde o evento [remote_session_saved] após autenticar antes de reiniciar/deployar.
 */

const express = require('express');
const fileUpload = require('express-fileupload');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');

const QRCode = require('qrcode');

let qrcodeTerm = null;
try { qrcodeTerm = require('qrcode-terminal'); } catch (_) {}

const PORT = process.env.PORT || 8000;

// ----------------- Estado do cliente -----------------
let isReady = false;
let lastState = null;
let lastAuthAt = null;
let lastQR = null;
let lastQRAt = null;
let loadingScreen = null;
let initializingAt = new Date();

// User-Agent estável (ajuda em ambientes headless)
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36';

// Instâncias globais
let client = null;
let store = null;

/** Cria/retorna uma nova instância do Client com RemoteAuth + MongoStore */
function createClient() {
  client = new Client({
    // >>> PERSISTÊNCIA DE SESSÃO VIA REMOTEAUTH (MongoStore) <<<
    authStrategy: new RemoteAuth({
      clientId: 'BOT-ZDG',
      store,
      // Faz backup periódico da sessão para o store remoto (mínimo aceito: 60.000 ms).
      backupSyncIntervalMs: 60_000
      // dataPath local temporário fica default; no restart, a sessão volta do Mongo
    }),

    takeoverOnConflict: true,
    takeoverTimeoutMs: 15_000,
    restartOnAuthFail: true,

    puppeteer: {
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-features=TranslateUI',
        '--hide-scrollbars',
        '--window-size=1280,800',
        '--lang=pt-BR',
        '--disable-quic',
        '--ignore-certificate-errors',
        '--ignore-certificate-errors-spki-list',
        `--user-agent=${USER_AGENT}`
      ]
      // Não defina executablePath: o Chrome já é baixado no build (postinstall) e será encontrado.
    }
  });

  // Zera/ajusta estado
  isReady = false;
  lastState = null;
  lastAuthAt = null;
  lastQR = null;
  lastQRAt = null;
  loadingScreen = null;
  initializingAt = new Date();

  // ====== Eventos (diagnóstico) ======
  client.on('loading_screen', (percent, msg) => {
    loadingScreen = { percent, msg, at: new Date() };
    console.log('[loading_screen]', percent, msg);
  });

  client.on('qr', (qr) => {
    lastQR = qr;
    lastQRAt = new Date();
    console.log('QR RECEIVED', `(at ${lastQRAt.toISOString()})`);
    if (qrcodeTerm) qrcodeTerm.generate(qr, { small: true });
  });

  client.once('authenticated', () => {
    lastAuthAt = new Date();
    console.log('₢ BOT-ZDG Autenticado', lastAuthAt.toISOString());
    lastQR = null;
    lastQRAt = null;
  });

  client.on('auth_failure', (m) => {
    console.error('[auth_failure]', m);
  });

  client.on('change_state', (state) => {
    lastState = state;
    console.log('[change_state]', state);
    if (state === 'CONNECTED' && !isReady) {
      isReady = true;
      console.log('[state->CONNECTED] isReady=true');
    }
  });

  client.once('ready', async () => {
    isReady = true;
    console.log('₢ BOT-ZDG Dispositivo pronto');
    try {
      lastState = await client.getState();
      console.log('getState() após ready:', lastState);
    } catch (e) {
      console.warn('getState() falhou após ready:', e?.message || String(e));
    }
  });

  // >>> Evento de confirmação de sessão salva no store remoto <<<
  client.on('remote_session_saved', (id) => {
    console.log('[remote_session_saved]', id || 'BOT-ZDG');
  });

  client.on('disconnected', (reason) => {
    isReady = false;
    console.warn('[disconnected]', reason);
  });

  client.initialize();
}

// ====== Conexão ao Mongo e bootstrap ======
(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('[FALTA MONGODB_URI] Configure a env MONGODB_URI no Render.');
  } else {
    try {
      await mongoose.connect(process.env.MONGODB_URI);
      console.log('[MongoDB] conectado');
      store = new MongoStore({ mongoose });
      createClient();
    } catch (e) {
      console.error('[MongoDB] erro ao conectar:', e?.message || String(e));
    }
  }
})();

// ====== Polling de estado (3s) ======
setInterval(async () => {
  try {
    const s = await client?.getState?.();
    if (s && s !== lastState) {
      console.log('[poll:getState] mudou:', lastState, '->', s);
      lastState = s;
    }
    if (s === 'CONNECTED' && !isReady) {
      isReady = true;
      console.log('[poll:getState] CONNECTED; isReady=true');
    }
  } catch (_) {}
}, 3000);

// ----------------- Express App -----------------
const app = express();

app.head('/', (_req, res) => res.status(200).end());
app.get('/healthz', (_req, res) => res.json({ ok: true, isReady, lastState, loadingScreen }));

app.use((req, _res, next) => {
  if (req.path !== '/healthz') {
    console.log(`${new Date().toISOString()} [${req.method}] ${req.url}`);
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Home dinâmica
app.get('/', async (_req, res) => {
  let currentState = lastState;
  try { currentState = await client?.getState?.(); } catch (_) {}
  const readyNow = isReady || currentState === 'CONNECTED';
  res
    .type('text/plain; charset=utf-8')
    .send(`App running on *:${PORT}\nBOT-ZDG: ${readyNow ? 'ready' : 'initializing'}\n`);
});

// QR em SVG
app.get('/qr', async (_req, res) => {
  try {
    if (!lastQR) {
      return res.status(404).type('text/plain; charset=utf-8')
        .send('QR ainda não disponível. Atualize em alguns segundos.');
    }
    const svg = await QRCode.toString(lastQR, { type: 'svg', errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Reset controlado
app.post('/reset', async (_req, res) => {
  try {
    console.warn('[reset] Reinicializando cliente...');
    if (client) {
      try { await client.destroy(); } catch (_) {}
    }
    createClient();
    return res.json({ ok: true, message: 'Cliente reinicializado. Aguarde o novo QR em /qr.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Status
app.get('/status', async (_req, res) => {
  let state = null;
  try { state = await client?.getState?.(); } catch (_) {}
  res.json({
    ok: true,
    isReady: isReady || state === 'CONNECTED',
    state: state || lastState || null,
    authenticatedAt: lastAuthAt,
    lastQRAt,
    loadingScreen,
    initializingAt
  });
});

// Envio de mensagem
app.post('/send-message', async (req, res) => {
  try {
    const { numero, message } = req.body || {};
    if (!numero || !message) {
      return res.status(400).json({ ok: false, error: 'Parâmetros obrigatórios: numero, message' });
    }

    let chatId = String(numero).trim();
    const isGroup = chatId.endsWith('@g.us');

    if (!isGroup) {
      if (!chatId.endsWith('@c.us')) {
        const digits = chatId.replace(/\D/g, '');
        if (!/^[1-9]\d{9,14}$/.test(digits)) {
          return res.status(400).json({
            ok: false,
            error: 'Formato inválido de numero. Envie em E.164: ex. 5511999999999 (DDI+DDD+número).'
          });
        }
        const wid = await client.getNumberId(digits);
        if (!wid || !wid._serialized) {
          return res.status(404).json({ ok: false, error: 'Número não encontrado no WhatsApp (getNumberId retornou vazio).' });
        }
        chatId = wid._serialized;
      }
    }

    const result = await client.sendMessage(chatId, message);
    return res.json({
      ok: true,
      id: (result && result.id && (result.id._serialized || result.id.id)) || null,
      to: chatId
    });
  } catch (e) {
    if ((e?.message || '').includes('No LID for user')) {
      return res.status(400).json({ ok: false, error: 'No LID for user: verifique o número (DDI+DDD) e se o contato tem WhatsApp.' });
    }
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Upload
app.post('/upload',
  fileUpload({ createParentPath: true, limits: { fileSize: 20 * 1024 * 1024 }, abortOnLimit: true }),
  async (req, res) => {
    if (!req.files || !req.files.file) return res.status(400).send('Nenhum arquivo recebido');
    const myFile = req.files.file;
    const saveDir = path.join(process.cwd(), 'uploads');
    fs.mkdirSync(saveDir, { recursive: true });
    const dest = path.join(saveDir, myFile.name);
    try {
      await myFile.mv(dest);
      res.json({ ok: true, saved: dest });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  }
);

// ----------------- HTTP server -----------------
const server = http.createServer(app);
server.listen(PORT, () => console.log(`App running on *: ${PORT}`));

/** Graceful shutdown: dá tempo ao RemoteAuth para flush do backup antes de sair */
function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  server.close(() => console.log('Servidor HTTP fechado.'));
  try { client?.destroy?.(); } catch (_) {}
  // Aumente o tempo de espera para permitir o snapshot no store remoto
  setTimeout(() => process.exit(0), 8000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
