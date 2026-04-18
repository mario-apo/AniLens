require("dotenv").config();

const TelegramBot = require("node-telegram-bot-api");
const axios = require("axios");
const FormData = require("form-data");

// 🔑 التوكن من .env
const token = process.env.BOT_TOKEN;

if (!token) {
    console.error("BOT_TOKEN is missing in .env");
    process.exit(1);
}

// 🤖 تشغيل البوت
const bot = new TelegramBot(token, {
    polling: {
        interval: 300,
        autoStart: true,
    },
});

// 🖼️ عند استقبال صورة
bot.on("photo", async (msg) => {
    const chatId = msg.chat.id;

    try {
        bot.sendMessage(chatId, "Processing image... chill 😎");

        // أخذ أعلى جودة صورة
        const fileId = msg.photo[msg.photo.length - 1].file_id;

        // جلب ملف الصورة من Telegram
        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

        const imageResponse = await axios.get(fileUrl, {
            responseType: "arraybuffer",
        });

        // تجهيزها لإرسالها لـ trace.moe
        const form = new FormData();
        form.append("image", Buffer.from(imageResponse.data), "image.jpg");

        // طلب البحث من trace.moe
        const result = await axios.post("https://api.trace.moe/search", form, {
            headers: form.getHeaders(),
        });

        const data = result.data?.result?.[0];

        if (!data) {
            return bot.sendMessage(chatId, "No anime found. skill issue maybe.");
        }

        const reply = `
🎬 Title: ${data.filename}
📺 Episode: ${data.episode ?? "unknown"}
⏱ Time: ${Math.floor(data.from)}s - ${Math.floor(data.to)}s
🎯 Similarity: ${(data.similarity * 100).toFixed(2)}%
`;

        bot.sendMessage(chatId, reply);
    } catch (err) {
        console.error(err?.response?.data || err.message);

        bot.sendMessage(
            chatId,
            "Something broke. either API cried or you did."
        );
    }
});

// 💬 لو حد كتب /start
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(
        msg.chat.id,
        "Send me an anime screenshot and I'll try to find it."
    );
});

console.log("TOKEN:", process.env.BOT_TOKEN);