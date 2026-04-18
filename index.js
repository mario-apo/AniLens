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

// 🧠 تحويل الثواني إلى h/m/s
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

// 🎬 جلب اسم الأنمي من AniList
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

// /start
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        "Send me an anime screenshot and I’ll identify it 🎬"
    );
});

// 🖼️ عند استقبال صورة
bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;

    try {
        bot.sendMessage(chatId, "Searching anime… 🧠");

        const fileId = msg.photo[msg.photo.length - 1].file_id;

        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

        const img = await axios.get(fileUrl, {
            responseType: "arraybuffer",
        });

        const form = new FormData();
        form.append("image", Buffer.from(img.data), "image.jpg");

        const result = await axios.post(
            "https://api.trace.moe/search",
            form,
            {
                headers: form.getHeaders(),
            }
        );

        const data = result.data?.result?.[0];

        if (!data) {
            return bot.sendMessage(chatId, "No match found.");
        }

        // 🎯 اسم الأنمي الحقيقي
        const animeTitle = await getAnimeTitle(data.anilist);

        // ⏱️ تنسيق الوقت
        const timeText = `${formatTime(data.from)} → ${formatTime(data.to)}`;

        // 📩 الرد
        const reply = `
🎬 Title: ${animeTitle}
📺 Episode: ${data.episode ?? "unknown"}
⏱ Time: ${timeText}
🎯 Similarity: ${(data.similarity * 100).toFixed(2)}%
`;

        await bot.sendMessage(chatId, reply);

        // 🎥 إرسال الفيديو إذا موجود
        if (data.video) {
            await bot.sendVideo(chatId, data.video, {
                caption: animeTitle,
            });
        }
    } catch (err) {
        console.error(err?.response?.data || err.message);

        bot.sendMessage(chatId, "Something broke. API probably misbehaving.");
    }
});