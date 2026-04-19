require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const express = require("express");

const token = process.env.BOT_TOKEN;

if (!token) {
    console.error("BOT_TOKEN missing");
    process.exit(1);
}

const bot = new TelegramBot(token);
const app = express();

app.use(express.json());

/* =========================
   🧠 Cache + Pending
========================= */
const cache = new Map();
const pending = new Map();

/* =========================
   🔑 ID Generator
========================= */
function generateId() {
    return Math.random().toString(36).substring(2, 10);
}

/* =========================
   ⏱️ Format Time
========================= */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    let str = "";
    if (h > 0) str += `${h}h `;
    if (m > 0 || h > 0) str += `${m}m `;
    str += `${s}s`;

    return str.trim();
}

/* =========================
   🎬 AniList Title
========================= */
async function getAnimeTitle(id) {
    try {
        const res = await axios.post("https://graphql.anilist.co", {
            query: `
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            title {
              romaji
              english
              native
            }
          }
        }
      `,
            variables: { id },
        });

        const t = res.data?.data?.Media?.title;
        return t?.english || t?.romaji || t?.native || "Unknown Anime";
    } catch {
        return "Unknown Anime";
    }
}

/* =========================
   🎯 Analyze Image
========================= */
async function analyzeImage(chatId, imageUrl) {
    try {
        if (cache.has(imageUrl)) {
            return bot.sendMessage(chatId, cache.get(imageUrl));
        }

        const img = await axios.get(imageUrl, {
            responseType: "arraybuffer",
        });

        const form = new FormData();
        form.append("image", Buffer.from(img.data), "image.jpg");

        const result = await axios.post(
            "https://api.trace.moe/search",
            form,
            { headers: form.getHeaders() }
        );

        const data = result.data?.result?.[0];

        if (!data) {
            return bot.sendMessage(chatId, "No match found.");
        }

        const title = await getAnimeTitle(data.anilist);
        const time = `${formatTime(data.from)} → ${formatTime(data.to)}`;

        const text = `
🎬 ${title}
📺 Episode: ${data.episode ?? "unknown"}
⏱ ${time}
🎯 ${(data.similarity * 100).toFixed(2)}%
`;

        cache.set(imageUrl, text);

        await bot.sendMessage(chatId, text);

        if (data.video) {
            await bot.sendVideo(chatId, data.video);
        }
    } catch (err) {
        console.error(err.message);
        bot.sendMessage(chatId, "Analysis failed.");
    }
}

/* =========================
   🔘 Analyze Button
========================= */
function sendAnalyzeButton(chatId, imageUrl) {
    const id = generateId();
    pending.set(id, imageUrl);

    bot.sendMessage(chatId, "Ready to analyze?", {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "🔍 Analyze",
                        callback_data: id,
                    },
                ],
            ],
        },
    });
}

/* =========================
   🌐 Extractors
========================= */

// Twitter (fxtwitter)
async function extractTwitterImage(url) {
    try {
        const id = url.split("/status/")[1];
        const api = `https://api.fxtwitter.com/v1/status/${id}`;
        const res = await axios.get(api);
        return res.data?.tweet?.media?.all?.[0]?.url || null;
    } catch {
        return null;
    }
}

// Reddit
async function extractRedditImage(url) {
    try {
        if (!url.endsWith("/")) url += "/";
        const res = await axios.get(url + ".json", {
            headers: { "User-Agent": "Mozilla/5.0" },
        });

        const post = res.data?.[0]?.data?.children?.[0]?.data;

        return (
            post?.preview?.images?.[0]?.source?.url ||
            post?.url_overridden_by_dest ||
            post?.url ||
            null
        );
    } catch {
        return null;
    }
}

// Facebook
async function extractFacebookImage(url) {
    try {
        const res = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
        });

        const match = res.data.match(/"og:image" content="(.*?)"/);
        return match ? match[1] : null;
    } catch {
        return null;
    }
}

/* =========================
   🤖 Handlers
========================= */

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Send image or link 🎬");
});

bot.on("photo", async (msg) => {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
    sendAnalyzeButton(msg.chat.id, url);
});

bot.on("message", async (msg) => {
    const chatId = msg.chat.id;

    if (msg.forward_from && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);

        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        return sendAnalyzeButton(chatId, url);
    }

    const text = msg.text;
    if (!text) return;

    let imageUrl = null;

    if (text.includes("twitter.com") || text.includes("x.com")) {
        imageUrl = await extractTwitterImage(text);
    } else if (text.includes("reddit.com")) {
        imageUrl = await extractRedditImage(text);
    } else if (text.includes("facebook.com")) {
        imageUrl = await extractFacebookImage(text);
    }

    if (imageUrl) {
        sendAnalyzeButton(chatId, imageUrl);
    }
});

bot.on("callback_query", async (query) => {
    const id = query.data;
    const chatId = query.message.chat.id;

    const imageUrl = pending.get(id);

    if (!imageUrl) {
        return bot.sendMessage(chatId, "Request expired.");
    }

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, "Analyzing… 🧠");

    await analyzeImage(chatId, imageUrl);

    pending.delete(id);
});

/* =========================
   🌐 Webhook Server
========================= */

const PORT = process.env.PORT || 3000;
const URL = process.env.RENDER_EXTERNAL_URL;

const URL = process.env.RENDER_EXTERNAL_URL;

if (!URL) {
  console.error("RENDER_EXTERNAL_URL is missing");
} else {
  bot.setWebHook(`${URL}/bot${token}`)
    .then(() => console.log("Webhook set successfully"))
    .catch(console.error);
}

app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

app.get("/", (req, res) => {
    res.send("AniLens bot running...");
});

app.listen(PORT, () => {
    console.log("Server running on port", PORT);
});