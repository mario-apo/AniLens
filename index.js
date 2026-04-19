require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");

const token = process.env.BOT_TOKEN;

if (!token) {
    console.error("BOT_TOKEN missing");
    process.exit(1);
}

const bot = new TelegramBot(token, {
    polling: true,
});

/* =========================
   🧠 Cache بسيط
========================= */
const cache = new Map();

/* =========================
   ⏱️ Time formatter
========================= */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    return `${h ? h + "h " : ""}${m ? m + "m " : ""}${s}s`;
}

/* =========================
   🎬 AniList
========================= */
async function getAnimeTitle(id) {
    try {
        const query = `
      query ($id: Int) {
        Media(id: $id, type: ANIME) {
          title {
            romaji
            english
            native
          }
        }
      }
    `;

        const res = await axios.post("https://graphql.anilist.co", {
            query,
            variables: { id },
        });

        const t = res.data?.data?.Media?.title;
        return t?.english || t?.romaji || t?.native || "Unknown Anime";
    } catch {
        return "Unknown Anime";
    }
}

/* =========================
   🎯 تحليل الصورة
========================= */
async function analyzeImage(chatId, imageUrl) {
    try {
        // ⚡ Cache
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
        bot.sendMessage(chatId, "Analysis failed.");
    }
}

/* =========================
   🌐 استخراج روابط
========================= */

// Twitter (via fxtwitter)
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

// Facebook (best effort)
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
   🔘 زر Analyze
========================= */
function sendAnalyzeButton(chatId, imageUrl) {
    bot.sendMessage(chatId, "Ready to analyze?", {
        reply_markup: {
            inline_keyboard: [
                [
                    {
                        text: "🔍 Analyze",
                        callback_data: imageUrl,
                    },
                ],
            ],
        },
    });
}

/* =========================
   🤖 Handlers
========================= */

// صور
bot.on("photo", async (msg) => {
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    sendAnalyzeButton(msg.chat.id, url);
});

// Forwarded messages
bot.on("message", async (msg) => {
    const chatId = msg.chat.id;

    // 📩 forward فيه صورة
    if (msg.forward_from && msg.photo) {
        const fileId = msg.photo[msg.photo.length - 1].file_id;
        const file = await bot.getFile(fileId);

        const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;
        return sendAnalyzeButton(chatId, url);
    }

    // 🔗 روابط
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

// 🔘 عند الضغط على Analyze
bot.on("callback_query", async (query) => {
    const imageUrl = query.data;
    const chatId = query.message.chat.id;

    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, "Analyzing… 🧠");

    await analyzeImage(chatId, imageUrl);
});