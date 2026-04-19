require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");
const express = require("express");

/* =========================
   🔧 ENV Variables
========================= */
const token = process.env.BOT_TOKEN;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const PORT = process.env.PORT || 3000;

if (!token) {
    console.error("❌ BOT_TOKEN missing");
    process.exit(1);
}

/* =========================
   🤖 Bot Setup (Webhook)
========================= */
const bot = new TelegramBot(token, { webHook: true });

const app = express();
app.use(express.json());

// Webhook route
app.post(`/bot${token}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// Health check
app.get("/", (req, res) => res.send("✅ AniLens Bot is running."));

app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);

    if (RENDER_URL) {
        const webhookURL = `${RENDER_URL}/bot${token}`;
        try {
            await bot.setWebHook(webhookURL);
            console.log(`✅ Webhook set: ${webhookURL}`);
        } catch (err) {
            console.error("❌ Failed to set webhook:", err.message);
        }
    } else {
        console.warn("⚠️ RENDER_EXTERNAL_URL not set — webhook not configured.");
    }
});

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
        // Return from cache if available
        if (cache.has(imageUrl)) {
            return bot.sendMessage(chatId, cache.get(imageUrl));
        }

        const img = await axios.get(imageUrl, { responseType: "arraybuffer" });

        const form = new FormData();
        form.append("image", Buffer.from(img.data), "image.jpg");

        const result = await axios.post("https://api.trace.moe/search", form, {
            headers: form.getHeaders(),
        });

        const data = result.data?.result?.[0];

        if (!data) {
            return bot.sendMessage(chatId, "❌ No match found.");
        }

        const title = await getAnimeTitle(data.anilist);
        const time = `${formatTime(data.from)} → ${formatTime(data.to)}`;

        const text = `🎬 *${title}*\n📺 Episode: ${data.episode ?? "unknown"}\n⏱ ${time}\n🎯 ${(data.similarity * 100).toFixed(2)}%`;

        cache.set(imageUrl, text);

        await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });

        if (data.video) {
            await bot.sendVideo(chatId, data.video);
        }
    } catch (err) {
        console.error("analyzeImage error:", err.message);
        bot.sendMessage(chatId, "⚠️ Analysis failed. Please try again.");
    }
}

/* =========================
   🔘 Send Analyze Button
========================= */
function sendAnalyzeButton(chatId, imageUrl) {
    const id = generateId();
    pending.set(id, imageUrl);

    bot.sendMessage(chatId, "🖼 Image received. Ready to analyze?", {
        reply_markup: {
            inline_keyboard: [
                [{ text: "🔍 Analyze", callback_data: id }],
            ],
        },
    });
}

/* =========================
   🌐 Link Extractors
========================= */

// Twitter / X via fxtwitter
async function extractTwitterImage(url) {
    try {
        const id = url.split("/status/")[1]?.split("?")[0];
        if (!id) return null;
        const res = await axios.get(`https://api.fxtwitter.com/v1/status/${id}`);
        return res.data?.tweet?.media?.all?.[0]?.url || null;
    } catch {
        return null;
    }
}

// Reddit
async function extractRedditImage(url) {
    try {
        const cleanUrl = url.endsWith("/") ? url : url + "/";
        const res = await axios.get(cleanUrl + ".json", {
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

// Facebook (OG meta tag)
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
   🤖 Bot Handlers
========================= */

// 📸 Direct photo
bot.on("photo", async (msg) => {
    try {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);
        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        sendAnalyzeButton(msg.chat.id, url);
    } catch (err) {
        console.error("photo handler error:", err.message);
    }
});

// 📩 Messages (forwarded photos + links)
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;

    // Forwarded photo
    if (msg.forward_from && msg.photo) {
        try {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            const file = await bot.getFile(fileId);
            const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
            return sendAnalyzeButton(chatId, url);
        } catch (err) {
            console.error("forward handler error:", err.message);
            return;
        }
    }

    // Text links
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

// 🔘 Inline button callback
bot.on("callback_query", async (query) => {
    const id = query.data;
    const chatId = query.message.chat.id;

    const imageUrl = pending.get(id);

    if (!imageUrl) {
        return bot.answerCallbackQuery(query.id, { text: "⚠️ Request expired." });
    }

    await bot.answerCallbackQuery(query.id);
    await bot.sendMessage(chatId, "🧠 Analyzing...");

    await analyzeImage(chatId, imageUrl);

    pending.delete(id);
});