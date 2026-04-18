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
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.google.com/",
            },
            timeout: 15000,
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

// headers مشتركة تحاكي متصفح حقيقي
const browserHeaders = {
    "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
};

// دالة مساعدة لاستخراج og:image من HTML
function extractOgImage(html) {
    const patterns = [
        /property=["']og:image["']\s+content=["'](https?:\/\/[^"']+)["']/i,
        /content=["'](https?:\/\/[^"']+)["']\s+property=["']og:image["']/i,
        /name=["']twitter:image["']\s+content=["'](https?:\/\/[^"']+)["']/i,
        /content=["'](https?:\/\/[^"']+)["']\s+name=["']twitter:image["']/i,
    ];

    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return match[1].replace(/&amp;/g, "&");
    }
    return null;
}

// 📘 Facebook
async function extractFacebookImage(url) {
    // Facebook يحجب الطلبات بشكل شبه كامل
    // أفضل حل: طلب المستخدم أرسال الصورة مباشرة
    return null;
}

// 🐦 Twitter/X — نستخدم fxtwitter كبروكسي مفتوح
async function extractTwitterImage(url) {
    try {
        // استخراج tweet ID من الرابط
        const match = url.match(/(?:twitter\.com|x\.com)\/\w+\/status\/(\d+)/);
        if (!match) return null;

        const tweetId = match[1];

        // fxtwitter يوفر API مجاني لجلب بيانات التغريدة
        const apiUrl = `https://api.fxtwitter.com/status/${tweetId}`;
        const res = await axios.get(apiUrl, {
            headers: browserHeaders,
            timeout: 10000,
        });

        const tweet = res.data?.tweet;

        // ابحث عن أول صورة في الميديا
        const media = tweet?.media?.photos?.[0]?.url
            || tweet?.media?.videos?.[0]?.thumbnail_url;

        return media || null;
    } catch (err) {
        console.error("Twitter extract error:", err.message);
        return null;
    }
}

// 👽 Reddit
async function extractRedditImage(url) {
    try {
        // نظف الرابط ونحول لـ JSON API
        let cleanUrl = url.split("?")[0].replace(/\/$/, "");
        if (!cleanUrl.endsWith(".json")) cleanUrl += ".json";

        const res = await axios.get(cleanUrl, {
            headers: {
                ...browserHeaders,
                "Accept": "application/json",
            },
            timeout: 10000,
        });

        const post = res.data?.[0]?.data?.children?.[0]?.data;
        if (!post) return null;

        // حالة 1: صورة مباشرة
        if (post.url_overridden_by_dest) {
            const directUrl = post.url_overridden_by_dest;
            if (/\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(directUrl)) {
                return directUrl;
            }
        }

        // حالة 2: reddit gallery (منشور متعدد الصور)
        if (post.gallery_data && post.media_metadata) {
            const firstItem = post.gallery_data.items?.[0];
            if (firstItem) {
                const mediaId = firstItem.media_id;
                const mediaInfo = post.media_metadata[mediaId];
                // أخذ أعلى جودة متاحة
                const source = mediaInfo?.s;
                if (source?.u) return source.u.replace(/&amp;/g, "&");
                if (source?.gif) return source.gif.replace(/&amp;/g, "&");
            }
        }

        // حالة 3: preview image
        const preview = post.preview?.images?.[0]?.source?.url;
        if (preview) return preview.replace(/&amp;/g, "&");

        return null;
    } catch (err) {
        console.error("Reddit extract error:", err.message);
        return null;
    }
}

// 📸 Instagram — نحاول عبر og:image
async function extractInstagramImage(url) {
    try {
        const res = await axios.get(url, {
            headers: browserHeaders,
            timeout: 10000,
        });
        return extractOgImage(res.data);
    } catch (err) {
        console.error("Instagram extract error:", err.message);
        return null;
    }
}

/* =========================
   🔗 Router للروابط
========================= */
async function handleLink(chatId, url) {
    await bot.sendMessage(chatId, "Processing link… 🧠");

    let imageUrl = null;
    let platform = "";

    if (url.includes("facebook.com") || url.includes("fb.com") || url.includes("fb.watch")) {
        platform = "Facebook";
        imageUrl = await extractFacebookImage(url);
    } else if (url.includes("twitter.com") || url.includes("x.com")) {
        platform = "Twitter/X";
        imageUrl = await extractTwitterImage(url);
    } else if (url.includes("reddit.com")) {
        platform = "Reddit";
        imageUrl = await extractRedditImage(url);
    } else if (url.includes("instagram.com")) {
        platform = "Instagram";
        imageUrl = await extractInstagramImage(url);
    }

    if (!imageUrl) {
        const hints = {
            "Facebook": "Facebook blocks automated access. Please take a screenshot and send it directly 📸",
            "Instagram": "Instagram requires login to view posts. Please send the image directly 📸",
            "Twitter/X": "Couldn't extract image from this tweet. Try sending the screenshot directly 📸",
            "Reddit": "Couldn't extract image from this Reddit post. Try sending the screenshot directly 📸",
        };

        const hint = hints[platform] || "Couldn't extract image. Send screenshot instead 📸";
        return bot.sendMessage(chatId, hint);
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
        "Send image or link (Twitter/X / Reddit / Instagram) 🎬\n\n" +
        "⚠️ Note: Facebook links are not supported due to access restrictions.\n" +
        "For best results, send a screenshot directly!"
    );
});

// 🖼️ صور مباشرة — لم يتغير شيء هنا
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
        text.includes("fb.com") ||
        text.includes("fb.watch") ||
        text.includes("twitter.com") ||
        text.includes("x.com") ||
        text.includes("reddit.com") ||
        text.includes("instagram.com")
    ) {
        await handleLink(chatId, text.trim());
    }
});