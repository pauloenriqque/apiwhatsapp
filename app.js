// app.js — whatsapp-web.js + RemoteAuth (Mongo) + QR no cliente + Express + Socket.IO
"use strict";
const express = require('express');
const fileUpload = require('express-fileupload');
const http = require('http');
const path = require('path');
const { Client, RemoteAuth, MessageMedia, List, Location } = require('whatsapp-web.js');
const { MongoClient } = require('mongodb');
const { MongoStore } = require('wwebjs-mongo');
const socketIO = require('socket.io');

const PORT = process.env.PORT || 8000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('[FATAL] MONGODB_URI não definida nas variáveis de ambiente.');
  process.exit(1);
}

// ----------------- App/Server/Socket -----------------
const app = express();
const server = http.createServer(app);
const io = socketIO(server); // compatível com socket.io 2.x

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: false }));

// Servir arquivos estáticos (CSS/JS/ícones, se quiser)
app.use('/public', express.static(path.join(__dirname, 'public')));

// Página inicial (cliente renderiza o QR)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Health check estável (configure o Render para usar esta rota)
app.get('/healthz', (req, res) => res.status(200).send('OK'));

// ----------------- WhatsApp Client (RemoteAuth + Mongo) -----------------
let client;       // whatsapp client
let mongoClient;  // conexão Mongo
let store;        // store do wwebjs-mongo
let restarting = false;
let isReady = false;

async function bootstrap() {
  // Conecta no Mongo uma única vez
  if (!mongoClient) {
    mongoClient = new MongoClient(MONGODB_URI, { family: 4 });
    await mongoClient.connect();
  }
  if (!store) {
    store = new MongoStore({ client: mongoClient, dbName: 'whatsapp' });
  }

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      backupSyncIntervalMs: 60_000, // persiste periodicamente no Mongo
    }),
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
      ],
    },
  });

  // Eventos do WhatsApp
  client.on('qr', (qr) => {
    // IMPORTANTE: enviamos o *texto* do QR para o cliente renderizar.
    // Assim, o QR é gerado no navegador, não no backend.
    io.emit('qr', { qr });
    io.emit('message', '₢ BOT-ZDG QRCode recebido — abra a câmera do seu celular.');
    console.log('[QR] emitido para clientes via Socket.IO');
  });

  client.on('ready', () => {
    isReady = true;
    io.emit('ready', '₢ BOT-ZDG Dispositivo pronto!');
    io.emit('message', '₢ BOT-ZDG Dispositivo pronto!');
    console.log('₢ BOT-ZDG Dispositivo pronto');
  });

  client.on('authenticated', () => {
    io.emit('authenticated', '₢ BOT-ZDG Autenticado!');
    io.emit('message', '₢ BOT-ZDG Autenticado!');
    console.log('₢ BOT-ZDG Autenticado');
  });

  client.on('auth_failure', (m) => {
    io.emit('message', '₢ BOT-ZDG falha na autenticação, tentando novamente...');
    console.error('[auth_failure]', m);
  });

  client.on('change_state', (state) => {
    console.log('₢ BOT-ZDG Status de conexão:', state);
  });

  client.on('disconnected', async (reason) => {
    isReady = false;
    io.emit('message', '₢ BOT-ZDG Cliente desconectado!');
    console.warn('[disconnected]', reason);
    if (!restarting) {
      restarting = true;
      try { await client.destroy(); } catch (e) {}
      setTimeout(async () => {
        try {
          await bootstrap(); // reinicia reaproveitando a sessão do Mongo
        } catch (e) {
          console.error('Falha ao reinicializar:', e);
        } finally {
          restarting = false;
        }
      }, 2000);
    }
  });

  await client.initialize();
}

// ----------------- Socket.IO (lado do cliente) -----------------
io.on('connection', (socket) => {
  socket.emit('message', '₢ BOT-ZDG - Iniciado');
  // Cliente pode requisitar o status atual
  socket.on('get-status', () => {
    socket.emit('status', { ready: isReady });
  });
});

// ----------------- API: enviar mensagem -----------------
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
        if (!/^\d{9,15}$/.test(digits)) {
          return res.status(400).json({ ok: false, error: 'Formato inválido. Use DDI+DDD+número. Ex.: 5511999999999' });
        }
        const wid = await client.getNumberId(digits);
        if (!wid || !wid._serialized) {
          return res.status(404).json({ ok: false, error: 'Número não encontrado no WhatsApp.' });
        }
        chatId = wid._serialized; // ex.: 5511999999999@c.us
      }
    }

    const result = await client.sendMessage(chatId, message);
    return res.json({ ok: true, id: result?.id?._serialized || result?.id?.id || null, to: chatId });
  } catch (e) {
    if ((e?.message || '').includes('No LID for user')) {
      return res.status(400).json({ ok: false, error: 'No LID for user: verifique o número e se o contato tem WhatsApp.' });
    }
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ----------------- Upload opcional -----------------
app.post('/upload', fileUpload({ createParentPath: true, limits: { fileSize: 20 * 1024 * 1024 }, abortOnLimit: true }), async (req, res) => {
  try {
    if (!req.files || !req.files.file) return res.status(400).send('Nenhum arquivo recebido');
    const myFile = req.files.file; // campo "file"
    const saveDir = path.join(process.cwd(), 'uploads');
    require('fs').mkdirSync(saveDir, { recursive: true });
    const dest = path.join(saveDir, myFile.name);
    await myFile.mv(dest);
    res.json({ ok: true, saved: dest });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ----------------- Start -----------------
server.listen(PORT, async () => {
  console.log('App running on *:' + PORT);
  try {
    await bootstrap();
  } catch (e) {
    console.error('Falha ao inicializar o WhatsApp:', e);
    process.exit(1);
  }
});

// ----------------- Graceful shutdown -----------------
function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  server.close(() => console.log('Servidor HTTP fechado.'));
  (async () => {
    try { await client?.destroy(); } catch (_) {}
    try { await mongoClient?.close(); } catch (_) {}
    setTimeout(() => process.exit(0), 800);
  })();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
