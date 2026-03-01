"use strict";

const express = require('express');
const fileUpload = require('express-fileupload');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode'); // para gerar SVG no endpoint /qr

let qrcodeTerm = null;
try { qrcodeTerm = require('qrcode-terminal'); } catch (_) {}

const PORT = process.env.PORT || 8000;

// ----------------- Estado do cliente -----------------
let isReady = false;
let lastState = null;
let lastAuthAt = null;
let lastQR = null;         // QR atual (texto)
let lastQRAt = null;       // quando recebemos o QR
let loadingScreen = null;  // progresso do loading

// ----------------- WhatsApp Web JS (Puppeteer) -----------------
// Não definimos `executablePath`: o Puppeteer usa o Chrome baixado no build e salvo em ./.cache/puppeteer
const client = new Client({
  authStrategy: new LocalAuth({ clientId: 'BOT-ZDG' }),
  puppeteer: {
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-zygote',
      '--single-process',
      '--window-size=1280,800',
      '--disable-features=TranslateUI',
      '--hide-scrollbars'
    ]
  }
});

// ====== Eventos p/ diagnóstico ======
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
  // limpamos o QR armazenado para evitar expor QR antigo
  lastQR = null;
  lastQRAt = null;
});

client.on('auth_failure', (m) => {
  console.error('[auth_failure]', m);
  // se falhar auth, em geral o fluxo volta a exibir QR
});

client.on('change_state', (state) => {
  lastState = state;
  console.log('[change_state]', state);
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

// ----------------- Express App -----------------
const app = express();

// Health-check minimalista (HEAD/GET)
app.head('/', (_req, res) => res.status(200).end());
app.get('/healthz', (_req, res) => res.json({ ok: true, isReady, lastState, loadingScreen }));

// Log simples de requests
app.use((req, _res, next) => {
  // Evita poluir muito os logs com health-checks
  if (req.path !== '/healthz') {
    console.log(`${new Date().toISOString()} [${req.method}] ${req.url}`);
  }
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

app.get('/', (_req, res) => {
  res
    .type('text/plain; charset=utf-8')
    .send(`App running on *:${PORT}\nBOT-ZDG: ${isReady ? 'ready' : 'initializing'}\n`);
});

// Novo: exibe o QR atual como SVG no navegador
app.get('/qr', async (_req, res) => {
  try {
    if (!lastQR) {
      return res
        .status(404)
        .type('text/plain; charset=utf-8')
        .send('QR ainda não disponível. Tente novamente em alguns segundos.');
    }
    const svg = await QRCode.toString(lastQR, { type: 'svg', errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// Status completo
app.get('/status', async (_req, res) => {
  let state = null;
  try { state = await client.getState(); } catch (_) {}
  res.json({
    ok: true,
    isReady,
    state: state || lastState || null,
    authenticatedAt: lastAuthAt,
    lastQRAt,
    loadingScreen
  });
});

// POST /send-message
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
        chatId = wid._serialized; // ex.: 5511999999999@c.us
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
    const myFile = req.files.file; // campo "file"
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

// Graceful shutdown
function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  server.close(() => console.log('Servidor HTTP fechado.'));
  try { client.destroy(); } catch (_) {}
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
