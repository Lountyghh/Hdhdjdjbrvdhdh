// Мини-приложение Telegram: посетитель пишет админу, админ отвечает через "Ответить".
// Админу приходит имя, @юзернейм и ID посетителя. Посетитель админского ника/ID не видит.
const express = require("express");
const crypto = require("crypto");
const path = require("path");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = Number(process.env.ADMIN_ID || 8231582344);
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;
if (!BOT_TOKEN) { console.error("Нет BOT_TOKEN"); process.exit(1); }
const SECRET = crypto.createHash("sha256").update("wh" + BOT_TOKEN).digest("hex").slice(0, 32);

const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const tg = (method, body) =>
  fetch(`${API}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(r => r.json()).catch(e => ({ ok: false, error: String(e) }));

// ---------- проверка пользователя Telegram (initData) ----------
function verifyInitData(initData) {
  try {
    const p = new URLSearchParams(initData);
    const hash = p.get("hash");
    if (!hash) return null;
    p.delete("hash");
    const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join("\n");
    const key = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
    const calc = crypto.createHmac("sha256", key).update(str).digest("hex");
    if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
    if (Date.now() / 1000 - Number(p.get("auth_date")) > 86400) return null;
    return JSON.parse(p.get("user"));
  } catch { return null; }
}

// Кто пишет: пользователь Telegram (проверенный) или гость из обычного браузера
function identify(req) {
  const init = req.get("x-init-data");
  if (init) {
    const u = verifyInitData(init);
    if (!u) return null;
    return { key: "u" + u.id, kind: "tg", id: u.id, username: u.username || "", name: [u.first_name, u.last_name].filter(Boolean).join(" ") };
  }
  const g = req.get("x-guest-sid");
  if (g && /^[a-f0-9]{16,32}$/.test(g)) return { key: "g" + g, kind: "guest", id: null, username: "", name: "", sid: g };
  return null;
}

// ---------- хранилище (в памяти) ----------
const chats = new Map();   // key -> { who, msgs }
const tgToKey = new Map(); // id сообщения у админа -> key
let counter = 0;

const hits = new Map();
function limited(key) {
  const now = Date.now();
  const a = (hits.get(key) || []).filter(t => now - t < 600000);
  if (a.length >= 30 || (a.length && now - a[a.length - 1] < 1000)) return true;
  a.push(now); hits.set(key, a); return false;
}

const app = express();
app.use(express.json({ limit: "20kb" }));
app.use(express.static(path.join(__dirname, "public")));
// Главная страница: public/index.html, а если папку public не загрузили — index.html рядом с server.js
app.get("/", (req, res) => {
  const f = [path.join(__dirname, "public", "index.html"), path.join(__dirname, "index.html")]
    .find(p => require("fs").existsSync(p));
  if (!f) return res.status(500).send("Файл index.html не найден: загрузите его в папку public (или рядом с server.js).");
  res.sendFile(f);
});

app.post("/api/send", async (req, res) => {
  const who = identify(req);
  if (!who) return res.status(401).json({ error: "Откройте чат через Telegram" });
  const text = typeof req.body.text === "string" ? req.body.text.trim().slice(0, 2000) : "";
  if (!text) return res.status(400).json({ error: "Пустое сообщение" });
  if (limited(who.key)) return res.status(429).json({ error: "Слишком часто, подождите секунду" });

  const chat = chats.get(who.key) || { who, msgs: [] };
  chat.who = who; chats.set(who.key, chat);
  const msg = { id: ++counter, from: "me", text, t: Date.now() };
  chat.msgs.push(msg);

  const head = who.kind === "tg"
    ? `👤 ${who.name || "Без имени"}\n🔗 ${who.username ? "@" + who.username : "юзернейма нет"}\n🆔 ${who.id}`
    : `👤 Гость из браузера (#${who.sid.slice(0, 6)})`;
  const r = await tg("sendMessage", { chat_id: ADMIN_ID, text: `${head}\n\n${text}` });
  if (!r.ok) { console.error(r); chat.msgs.pop(); return res.status(502).json({ error: "Не удалось отправить, попробуйте позже" }); }
  tgToKey.set(r.result.message_id, who.key);
  res.json({ ok: true, id: msg.id, t: msg.t });
});

app.get("/api/messages", (req, res) => {
  const who = identify(req);
  if (!who) return res.status(401).json({ error: "auth" });
  const after = Number(req.query.after || 0);
  const chat = chats.get(who.key);
  res.json({ msgs: chat ? chat.msgs.filter(m => m.id > after) : [] });
});

// ---------- вебхук бота ----------
app.post("/tg-webhook", (req, res) => {
  res.sendStatus(200);
  if (req.get("x-telegram-bot-api-secret-token") !== SECRET) return;
  handle(req.body);
});

async function handle(u) {
  const m = u && u.message;
  if (!m || !m.from) return;

  if (m.from.id !== ADMIN_ID) { // обычный пользователь открыл бота
    if (m.chat.type === "private" && PUBLIC_URL) {
      tg("sendMessage", { chat_id: m.chat.id, text: "Нажмите кнопку, чтобы написать админу 👇",
        reply_markup: { inline_keyboard: [[{ text: "Написать админу", web_app: { url: PUBLIC_URL } }]] } });
    }
    return;
  }
  if (m.text === "/start") {
    return tg("sendMessage", { chat_id: ADMIN_ID, text: "Готово ✅ Сообщения посетителей будут приходить сюда с их именем, @юзернеймом и ID.\nЧтобы ответить — нажмите «Ответить» на сообщение." });
  }
  const key = m.reply_to_message && tgToKey.get(m.reply_to_message.message_id);
  if (!key || !m.text) {
    return tg("sendMessage", { chat_id: ADMIN_ID, text: key === undefined && m.reply_to_message ? "Этот чат не найден (сервер перезапускался)." : "Чтобы ответить посетителю, нажмите «Ответить» на его сообщение." });
  }
  const chat = chats.get(key);
  if (!chat) return;
  chat.msgs.push({ id: ++counter, from: "admin", text: m.text.slice(0, 4000), t: Date.now() });
  tg("setMessageReaction", { chat_id: ADMIN_ID, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👍" }] });
}

app.listen(PORT, async () => {
  console.log("Сервер на порту", PORT);
  if (PUBLIC_URL) {
    const r = await tg("setWebhook", { url: `${PUBLIC_URL}/tg-webhook`, secret_token: SECRET, allowed_updates: ["message"] });
    console.log("Webhook:", r.ok ? "ок" : r);
    await tg("setChatMenuButton", { menu_button: { type: "web_app", text: "Написать", web_app: { url: PUBLIC_URL } } });
  } else {
    await tg("deleteWebhook", {});
    let offset = 0;
    for (;;) {
      const r = await tg("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
      if (!r.ok) { await new Promise(x => setTimeout(x, 3000)); continue; }
      for (const u of r.result) { offset = u.update_id + 1; handle(u); }
    }
  }
});
