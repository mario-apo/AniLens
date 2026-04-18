require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");

const token = process.env.BOT_TOKEN;

if (!token) {
    console.error("BOT_TOKEN missing in .env");
    process.exit(1);
}

const bot = new TelegramBot(token, {
    polling: {
        interval: 300,
        autoStart: true,
    },
});

/* =========================
   ⏱️ تنسيق الوقت
========================= */
function formatTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);

    let result = "";
    if (h > 0) result += `${h}h `;
    if (m > 0 || h > 0) result += `${m}m `;
    result += `${s}s`;
    return result.trim();
}

/* =========================
   🎬 AniList Title
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
   🖼️ معالجة الصورة من URL
========================= */
async function processImageFromUrl(chatId, imageUrl) {
    try {
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
            return bot.sendMessage(chatId, "No anime found.");
        }

        const title = await getAnimeTitle(data.anilist);
        const time = `${formatTime(data.from)} → ${formatTime(data.to)}`;

        const reply = `
🎬 Title: ${title}
📺 Episode: ${data.episode ?? "unknown"}
⏱ Time: ${time}
🎯 Similarity: ${(data.similarity * 100).toFixed(2)}%
`;

        await bot.sendMessage(chatId, reply);

        if (data.video) {
            await bot.sendVideo(chatId, data.video, {
                caption: title,
            });
        }
    } catch (err) {
        console.error(err.message);
        bot.sendMessage(chatId, "Failed to process image.");
    }
}

/* =========================
   🌐 استخراج الصور من الروابط
========================= */

// 📘 Facebook (محاولة بسيطة)
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

// 🐦 Twitter/X (أفضل محاولة متاحة بدون API رسمي)
async function extractTwitterImage(url) {
    try {
        const res = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
        });

        const match =
            res.data.match(/property="og:image" content="(.*?)"/) ||
            res.data.match(/twitter:image" content="(.*?)"/);

        return match ? match[1] : null;
    } catch {
        return null;
    }
}

// 👽 Reddit
async function extractRedditImage(url) {
    try {
        if (!url.endsWith(".json")) url += ".json";

        const res = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0" },
        });

        const data = res.data?.[0]?.data?.children?.[0]?.data;

        return data?.url_overridden_by_dest || data?.url || null;
    } catch {
        return null;
    }
}

/* =========================
   🔗 Router للروابط
========================= */
async function handleLink(chatId, url) {
    bot.sendMessage(chatId, "Processing link… 🧠");

    let imageUrl = null;

    if (url.includes("facebook.com")) {
        imageUrl = await extractFacebookImage(url);
    } else if (url.includes("twitter.com") || url.includes("x.com")) {
        imageUrl = await extractTwitterImage(url);
    } else if (url.includes("reddit.com")) {
        imageUrl = await extractRedditImage(url);
    }

    if (!imageUrl) {
        return bot.sendMessage(
            chatId,
            "Couldn't extract image. Send screenshot instead."
        );
    }

    await processImageFromUrl(chatId, imageUrl);
}

/* =========================
   🤖 Telegram handlers
========================= */

// /start
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        "Send image or link (Facebook / Twitter / Reddit) 🎬"
    );
});

// 🖼️ صور مباشرة
bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;

    const fileId = msg.photo[msg.photo.length - 1].file_id;
    const file = await bot.getFile(fileId);

    const url = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    await processImageFromUrl(chatId, url);
});

// 🔗 روابط
bot.on("message", async (msg) => {
    const text = msg.text;
    const chatId = msg.chat.id;

    if (!text) return;

    if (
        text.includes("facebook.com") ||
        text.includes("twitter.com") ||
        text.includes("x.com") ||
        text.includes("reddit.com")
    ) {
        await handleLink(chatId, text);
    }
});