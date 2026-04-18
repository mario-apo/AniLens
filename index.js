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

// 📌 /start
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        "Send me an anime screenshot and I’ll try to identify it 🎬"
    );
});

// 🖼️ عند استقبال صورة
bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;

    try {
        bot.sendMessage(chatId, "Searching anime… give me a sec 🧠");

        // أعلى جودة صورة
        const fileId = msg.photo[msg.photo.length - 1].file_id;

        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

        const imageBuffer = await axios.get(fileUrl, {
            responseType: "arraybuffer",
        });

        // إرسال الصورة لـ trace.moe
        const form = new FormData();
        form.append("image", Buffer.from(imageBuffer.data), "image.jpg");

        const result = await axios.post(
            "https://api.trace.moe/search",
            form,
            {
                headers: form.getHeaders(),
            }
        );

        const data = result.data?.result?.[0];

        if (!data) {
            return bot.sendMessage(chatId, "No match found. try another image.");
        }

        // 🎯 استخراج اسم أنمي صحيح
        const animeTitle =
            data.anilist?.title?.english ||
            data.anilist?.title?.romaji ||
            data.anilist?.title?.native ||
            "Unknown Anime";

        // 📄 رسالة النتيجة
        const reply = `
🎬 Title: ${animeTitle}
📺 Episode: ${data.episode ?? "unknown"}
⏱ Time: ${Math.floor(data.from)}s - ${Math.floor(data.to)}s
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

        bot.sendMessage(
            chatId,
            "Something went wrong. API probably tripped."
        );
    }
});