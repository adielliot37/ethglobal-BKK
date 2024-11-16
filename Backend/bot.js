const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const mongoose = require('mongoose');


const MONGO_URI = process.env.MONGO_URI;

mongoose.connect(MONGO_URI)
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch((err) => console.error('Error connecting to MongoDB Atlas:', err));


const mentorSchema = new mongoose.Schema({
    telegram_id: { type: String, required: true, unique: true }, 
    username: String,
    assigned_tables: [Number],
    total_requests_served: { type: Number, default: 0 },
    ratings: [{ request_number: Number, rating: Number }],
});

const requestSchema = new mongoose.Schema({
    request_number: { type: Number, unique: true },
    table_no: Number,
    user_name: String,
    user_tg: String, 
    mentor_tg: String, 
    status: { type: String, default: 'pending' },
    rating: { type: Number, default: null },
    signature: {
        digest: String,
        etherAddress: String,
    },
});

const Mentor = mongoose.model('Mentor', mentorSchema);
const Request = mongoose.model('Request', requestSchema);


const BOT_TOKEN = process.env.BOT_TOKEN;
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('Telegram bot is running...');


bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;

    
    bot.answerCallbackQuery(callbackQuery.id).catch((err) => console.error('Error acknowledging callback query:', err));

    if (data.startsWith('rate_')) {
        const request_number = parseInt(data.split('_')[1]);
        const chatId = callbackQuery.message.chat.id;

        try {
            const request = await Request.findOne({ request_number });

            if (!request) {
                return bot.answerCallbackQuery(callbackQuery.id, { text: 'Request not found.', show_alert: true });
            }

           
            if (request.rating !== null) {
                return bot.answerCallbackQuery(callbackQuery.id, { text: 'You have already rated this mentor.', show_alert: true });
            }

            
            const ratingURL = `https://arx.netlify.app?request_number=${request_number}`;

           
            await bot.sendMessage(chatId, `Please rate the mentor by clicking the link below:`, {
                reply_markup: {
                    inline_keyboard: [
                        [
                            {
                                text: "Open in Browser",
                                url: ratingURL, 
                            },
                        ],
                    ],
                },
            });
        } catch (error) {
            console.error('Error handling rate button:', error);
            bot.answerCallbackQuery(callbackQuery.id, { text: 'An error occurred. Please try again.', show_alert: true });
        }
    }

    
    if (data.startsWith('accept_')) {
        const request_number = parseInt(data.split('_')[1]);
        const mentorTelegramId = callbackQuery.from.id.toString(); 

        try {
            
            const request = await Request.findOneAndUpdate(
                { request_number, status: 'pending' }, 
                { status: 'accepted', mentor_tg: mentorTelegramId }, 
                { new: true } 
            );

            if (!request) {
                
                return bot.sendMessage(callbackQuery.from.id, '❌ This request has already been accepted.');
            }

           
            const mentor = await Mentor.findOneAndUpdate(
                { telegram_id: mentorTelegramId }, 
                {
                    $inc: { total_requests_served: 1 }, 
                    $push: { ratings: { request_number, rating: null } }, 
                },
                { new: true } 
            );

            if (!mentor) {
                console.error(`Mentor not found. Telegram ID: ${mentorTelegramId}`);
                return bot.sendMessage(callbackQuery.from.id, '❌ Mentor not found. Please ensure your data is correct.');
            }

           
            await bot.sendMessage(request.user_tg, `✅ Your request has been accepted by Mentor ${mentor.username}. Please rate them after the session.`, {
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [
                            {
                                text: "Rate Mentor",
                                callback_data: `rate_${request_number}`,
                            },
                        ],
                    ],
                }),
            });

            
            bot.sendMessage(callbackQuery.from.id, '✅ You have successfully accepted the request!');
        } catch (error) {
            console.error('Error handling callback query:', error);
            bot.sendMessage(callbackQuery.from.id, '❌ An error occurred while processing the request. Please try again.');
        }
    }
});


async function notifyMentors(request_number, table_no, user_name, user_tg) {
    try {
        const assignedMentors = await Mentor.find({ assigned_tables: table_no });

        for (const mentor of assignedMentors) {
            await bot.sendMessage(mentor.telegram_id, `🚨 *Help Request*\n\n👤 User: ${user_name}\n📱 Telegram: @${user_tg}\n📍 Table: ${table_no}`, {
                parse_mode: 'Markdown',
                reply_markup: JSON.stringify({
                    inline_keyboard: [
                        [
                            {
                                text: "Accept Request",
                                callback_data: `accept_${request_number}`,
                            },
                        ],
                    ],
                }),
            });
        }
    } catch (error) {
        console.error('Error notifying mentors:', error);
    }
}