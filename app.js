// app.js — WhatsApp Web JS + RemoteAuth (Mongo via Mongoose) + QR no cliente + Health Check + Retry
"use strict";

const express = require("express");
const fileUpload = require("express-fileupload");
const http = require("http");
const path = require("path");
const socketIO = require("socket.io");

const { Client, RemoteAuth, MessageMedia, List, Location } = require("whatsapp-web.js");
const mongoose = require("mongoose");
const { MongoStore } = require("wwebjs-mongo");

const PORT = process.env.PORT || 8000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("[FATAL] MONGODB_URI não definida nas variáveis de ambiente.");
  // Não encerramos o processo; deixamos o Render ver o /healthz (que vai falhar) e logs
}

// ----------------- App/Server/Socket -----------------
const app = express();
const server = http.createServer(app);
const io = socketIO(server); // compatível com socket.io 2.x

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(fileUpload({ debug: false }));

// Servir estáticos (se quiser colocar CSS/JS/ícones em /public)
app.use("/public", express.static(path.join(__dirname, "public")));

// Página inicial (cliente renderiza o QR no navegador)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Health check estável (configure o Render para apontar para este path)
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// Rota de status útil para diagnóstico rápido
let isReady = false;
app.get("/status", (req, res) => {
  let mongo = "desconhecido";
  try { mongo = mongoose.connection.readyState; } catch (_) {}
  // readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
  res.json({ ok: true, ready: isReady, mongoReadyState: mongo });
});

// ----------------- WhatsApp Client (RemoteAuth + Mongo via Mongoose) -----------------
let client;       // whatsapp client
let store;        // wwebjs-mongo store
let restarting = false;

async function bootstrap() {
  // 1) Conecta no Mongoose (uma única vez)
  if (MONGODB_URI) {
    if (mongoose.connection.readyState === 0) {
      await mongoose.connect(MONGODB_URI, { family: 4 });
      console.log("[MongoDB] conectado via Mongoose");
    }
  } else {
    throw new Error("MONGODB_URI ausente");
  }

  // 2) Cria o MongoStore com a instância do Mongoose (exigência do wwebjs-mongo)
  if (!store) {
    store = new MongoStore({ mongoose }); // <- obrigatório ser o mongoose (não MongoClient)
  }

  // 3) Cria client com RemoteAuth usando o store
  client = new Client({
    authStrategy: new RemoteAuth({
      store,
      backupSyncIntervalMs: 60_000, // grava periodicamente a sessão no Mongo
    }),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
      ],
    },
  });

  // === Eventos do WhatsApp ===
  client.on("qr", (qr) => {
    // Envia somente o TEXTO do QR para o cliente renderizar com qrcode.min.js
    io.emit("qr", { qr });
    io.emit("message", "₢ BOT-ZDG QRCode recebido — abra a câmera do seu celular.");
    console.log("[QR] emitido para clientes via Socket.IO");
  });

  client.on("ready", () => {
    isReady = true;
    io.emit("ready", "₢ BOT-ZDG Dispositivo pronto!");
    io.emit("message", "₢ BOT-ZDG Dispositivo pronto!");
    console.log("₢ BOT-ZDG Dispositivo pronto");
  });

  client.on("authenticated", () => {
    io.emit("authenticated", "₢ BOT-ZDG Autenticado!");
    io.emit("message", "₢ BOT-ZDG Autenticado!");
    console.log("₢ BOT-ZDG Autenticado");
  });

  client.on("auth_failure", (m) => {
    io.emit("message", "₢ BOT-ZDG falha na autenticação, tentando novamente...");
    console.error("[auth_failure]", m);
  });

  client.on("change_state", (state) => {
    console.log("₢ BOT-ZDG Status de conexão:", state);
  });

  client.on("disconnected", async (reason) => {
    isReady = false;
    io.emit("message", "₢ BOT-ZDG Cliente desconectado!");
    console.warn("[disconnected]", reason);
    if (!restarting) {
      restarting = true;
      try { await client.destroy(); } catch (_) {}
      setTimeout(async () => {
        try {
          await bootstrap(); // reinicia reaproveitando a sessão do Mongo
        } catch (e) {
          console.error("Falha ao reinicializar:", e);
        } finally {
          restarting = false;
        }
      }, 2000);
    }
  });

  await client.initialize();
}

// ----------------- Socket.IO (lado do cliente) -----------------
io.on("connection", (socket) => {
  socket.emit("message", "₢ BOT-ZDG - Iniciado");
  socket.on("get-status", () => {
    socket.emit("status", { ready: isReady });
  });
});

// ----------------- API: enviar mensagem -----------------
app.post("/send-message", async (req, res) => {
  try {
    const { numero, message } = req.body || {};
    if (!numero || !message) {
      return res.status(400).json({ ok: false, error: "Parâmetros obrigatórios: numero, message" });
    }

    let chatId = String(numero).trim();
    const isGroup = chatId.endsWith("@g.us");

    if (!isGroup) {
      if (!chatId.endsWith("@c.us")) {
        const digits = chatId.replace(/\D/g, "");
        if (!/^\d{9,15}$/.test(digits)) {
          return res.status(400).json({ ok: false, error: "Formato inválido. Use DDI+DDD+número. Ex.: 5511999999999" });
        }
        const wid = await client.getNumberId(digits);
        if (!wid || !wid._serialized) {
          return res.status(404).json({ ok: false, error: "Número não encontrado no WhatsApp." });
        }
        chatId = wid._serialized; // ex.: 5511999999999@c.us
      }
    }

    const result = await client.sendMessage(chatId, message);
    return res.json({ ok: true, id: result?.id?._serialized || result?.id?.id || null, to: chatId });
  } catch (e) {
    if ((e?.message || "").includes("No LID for user")) {
      return res.status(400).json({ ok: false, error: "No LID for user: verifique o número e se o contato tem WhatsApp." });
    }
    return res.status(500).json({ ok: false, error: e?.message || String(e) });
  }
});

// ----------------- Start + Retry com backoff -----------------
async function startWhatsAppWithRetry(retry = 0) {
  try {
    await bootstrap();
  } catch (e) {
    console.error("Falha ao inicializar o WhatsApp:", e?.stack || e);
    const delay = Math.min(30000, 2000 * (retry + 1)); // 2s, 4s, 6s... máx 30s
    console.log(`Reiniciando bootstrap em ${delay} ms (tentativa ${retry + 1})`);
    setTimeout(() => startWhatsAppWithRetry(retry + 1), delay);
  }
}

server.listen(PORT, () => {
  console.log("App running on *:" + PORT);
  startWhatsAppWithRetry();
});

// ----------------- Graceful shutdown -----------------
function shutdown(signal) {
  console.log(`\n${signal} recebido. Encerrando...`);
  server.close(() => console.log("Servidor HTTP fechado."));
  (async () => {
    try { await client?.destroy(); } catch (_) {}
    try { await mongoose.connection.close(false); } catch (_) {}
    setTimeout(() => process.exit(0), 800);
  })();
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
