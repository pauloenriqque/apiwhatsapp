// app.js (RemoteAuth + Mongo — PERSISTE a sessão)
const { Client, RemoteAuth, MessageMedia, List, Location } = require('whatsapp-web.js');
const express = require('express');
const { body, validationResult } = require('express-validator');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const fileUpload = require('express-fileupload');
const { MongoClient } = require('mongodb');
const { MongoStore } = require('wwebjs-mongo');

const PORT = process.env.PORT || 8000;
const MONGODB_URI = process.env.MONGODB_URI; // defina no Render

if (!MONGODB_URI) {
  console.error('Falta a env MONGODB_URI');
  process.exit(1);
}

const app = express();
const server = http.createServer(app);
const io = socketIO(server, { cors: { origin: '*' } });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: false }));
app.use('/', express.static(__dirname + '/'));

app.get('/', (req, res) => {
  res.sendFile('index.html', { root: __dirname });
});
app.get('/healthz', (req, res) => res.status(200).send('OK'));

let restarting = false;
let client; // whatsapp client
let mongoClient;
let store;

async function bootstrap() {
  mongoClient = new MongoClient(MONGODB_URI, { family: 4 });
  await mongoClient.connect();
  store = new MongoStore({ client: mongoClient, dbName: 'whatsapp' });

  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      backupSyncIntervalMs: 60_000, // salva credenciais periodicamente
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
        '--disable-gpu'
      ]
    }
  });

  client.on('qr', async (qr) => {
    console.log('QR RECEIVED');
    // Com RemoteAuth o QR aparece apenas na primeira vez (ou se a sessão expirar)
    const dataUrl = await qrcode.toDataURL(qr);
    io.emit('qr', dataUrl);
    io.emit('message', '₢ BOT-ZDG QRCode recebido, aponte a câmera do seu celular!');
  });

  client.on('ready', () => {
    io.emit('ready', '₢ BOT-ZDG Dispositivo pronto!');
    io.emit('message', '₢ BOT-ZDG Dispositivo pronto!');
    io.emit('qr', './check.svg');
    console.log('₢ BOT-ZDG Dispositivo pronto');
  });

  client.on('authenticated', () => {
    io.emit('authenticated', '₢ BOT-ZDG Autenticado!');
    io.emit('message', '₢ BOT-ZDG Autenticado!');
    console.log('₢ BOT-ZDG Autenticado');
  });

  client.on('auth_failure', () => {
    io.emit('message', '₢ BOT-ZDG falha na autenticação, reiniciando...');
    console.error('₢ BOT-ZDG falha na autenticação');
  });

  client.on('change_state', (state) => {
    console.log('₢ BOT-ZDG Status de conexão: ', state);
  });

  client.on('disconnected', (reason) => {
    io.emit('message', '₢ BOT-ZDG Cliente desconectado!');
    console.log('₢ BOT-ZDG Cliente desconectado', reason);
    if (!restarting) {
      restarting = true;
      setTimeout(async () => {
        try {
          await client.destroy();
        } catch {}
        await bootstrap(); // reinicia com as mesmas credenciais do Mongo
        restarting = false;
      }, 2000);
    }
  });

  await client.initialize();
}

io.on('connection', (socket) => {
  socket.emit('message', '₢ BOT-ZDG - Iniciado');
  socket.emit('qr', './icon.svg');
});

// POST /send-message
app.post('/send-message', [
  body('number').notEmpty(),
  body('message').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req).formatWith(({ msg }) => msg);
  if (!errors.isEmpty()) {
    return res.status(422).json({ status: false, message: errors.mapped() });
  }

  const number = req.body.number;
  const message = req.body.message;
  const numberDDI = number.substr(0, 2);
  const numberDDD = number.substr(2, 2);
  const numberUser = number.substr(-8, 8);

  function send(to) {
    return client.sendMessage(to, message)
      .then(response => res.status(200).json({ status: true, message: 'BOT-ZDG Mensagem enviada', response }))
      .catch(err => res.status(500).json({ status: false, message: 'BOT-ZDG Mensagem não enviada', response: err?.message || err }));
  }

  if (numberDDI !== '55') {
    return send(number + '@c.us');
  } else if (parseInt(numberDDD) <= 30) {
    return send('55' + numberDDD + '9' + numberUser + '@c.us');
  } else {
    return send('55' + numberDDD + numberUser + '@c.us');
  }
});

server.listen(PORT, async () => {
  console.log('App running on *: ' + PORT);
  try {
    await bootstrap();
  } catch (e) {
    console.error('Falha ao inicializar o WhatsApp:', e);
    process.exit(1);
  }
});

// Encerramento gracioso
process.on('SIGTERM', async () => {
  console.log('SIGTERM recebido. Encerrando...');
  try { await client?.destroy(); } catch {}
  try { await mongoClient?.close(); } catch {}
  server.close(() => process.exit(0));
});
