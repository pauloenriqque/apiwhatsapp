"use strict";

const express = require('express');
const fileUpload = require('express-fileupload');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
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

// IMPORTANTE: Não definimos executablePath (Puppeteer encontra o Chrome baixado no build)
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'BOT-ZDG' /*, dataPath: '/data/.wwebjs_auth'*/ }),
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
      '--ignore-certificate-errors-spki-list'
    ]
  }
});

// ====== Eventos detalhados p/ diagnóstico ======
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

client.on('authenticated', () => {
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
    // Marcação otimista: já estamos conectados; aguardar 'ready' não é estritamente necessário
    isReady = true;
    console.log('[state->CONNECTED] Marcando isReady=true');
  }
});

client.on('ready', async () => {
  isReady = true;
  console.log('₢ BOT-ZDG Dispositivo pronto');
  try {
    lastState = await client.getState();
    console.log('getState() após ready:', lastState);
  } catch (e) {
    console.warn('getState() falhou após ready:', e?.message || String(e));
  }
});

client.on('disconnected', (reason) => {
  isReady = false;
  console.warn('[disconnected]', reason);
});

// Inicia o cliente
client.initialize();

// ====== Polling leve de estado (a cada 3s) ======
// Garante que, se estivermos CONNECTED mas 'ready' não tiver disparado, a home mostre 'ready'
setInterval(async () => {
  try {
    const s = await client.getState();
    if (s && s !== lastState) {
      console.log('[poll:getState] mudou:', lastState, '->', s);
      lastState = s;
    }
    if (s === 'CONNECTED' && !isReady) {
      isReady = true;
      console.log('[poll:getState] CONNECTED; isReady=true');
    }
  } catch (_) {
    // silencioso
  }
}, 3000);

// ----------------- Express App -----------------
const app = express();

// Health-check minimalista
app.head('/', (_req, res) => res.status(200).end());
app.get('/healthz', (_req, res) => res.json({ ok: true, isReady, lastState, loadingScreen }));

// Log simples de requests (evita poluir com /healthz)
app.use((req, _res, next) => {
  if (req.path !== '/healthz') {
    console.log(`${new Date().toISOString()} [${req.method}] ${req.url}`);
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Home agora consulta o estado atual para refletir 'ready' assim que CONNECTED
app.get('/', async (_req, res) => {
  let currentState = lastState;
  try { currentState = await client.getState(); } catch (_) {}
  const readyNow = isReady || currentState === 'CONNECTED';
  res
    .type('text/plain; charset=utf-8')
    .send(`App running on *:${PORT}\nBOT-ZDG: ${readyNow ? 'ready' : 'initializing'}\n`);
});

// Exibe QR atual como SVG
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

// Status
app.get('/status', async (_req, res) => {
  let state = null;
  try { state = await client.getState(); } catch (_) {}
  res.json({
    ok: true,
    isReady: isReady || state === 'CONNECTED',
    state: state || lastState || null,
    authenticatedAt: lastAuthAt,
    lastQRAt,
    loadingScreen
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
      if (chatId.endsWith('@c.us')) {
        // ok
      } else {
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

function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  server.close(() => console.log('Servidor HTTP fechado.'));
  try { client.destroy(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
