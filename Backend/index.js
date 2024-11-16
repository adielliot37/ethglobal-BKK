require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const axios = require('axios');
const cors = require('cors');
const { BigNumber, Contract, ethers } = require("ethers");
const abi = require("./abi.json"); 
const app = express();
app.use(express.json());

app.use(cors({
    origin: '*',  
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], 
    allowedHeaders: ['Content-Type', 'Authorization'], 
    credentials: true 
}));

const MONGO_URI = process.env.MONGO_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;
const PRIVATE_KEY = process.env.PRIVATE_KEY;


mongoose.connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
})
    .then(() => console.log('Connected to MongoDB Atlas'))
    .catch((err) => console.error('Error connecting to MongoDB Atlas:', err));


const mentorSchema = new mongoose.Schema({
    telegram_id: String,
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
    transactionHash: { type: String, default: null }, 
    attestationId: { type: String, default: null }, 
});

const UserSchema = new mongoose.Schema({
    uid: { type: String, required: true, unique: true },
    name: { type: String, required: true },
    tg_username: { type: String, required: true },
  });

  const User = mongoose.model('User', UserSchema);

const Mentor = mongoose.model('Mentor', mentorSchema);
const Request = mongoose.model('Request', requestSchema);



const TELEGRAM_API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;


async function generateRequestNumber() {
    const lastRequest = await Request.findOne().sort({ request_number: -1 });
    return lastRequest ? lastRequest.request_number + 1 : 1;
}


app.use((req, res, next) => {
    console.log(`Incoming Request: ${req.method} ${req.url}`);
    console.log(`Request Body: ${JSON.stringify(req.body, null, 2)}`);
    next();
});


app.get('/api/get_user', async (req, res) => {
    const { uid } = req.query; 
  
    if (!uid) {
        return res.status(400).json({ error: 'UID is required' });
    }
  
    try {
       
        const user = await User.findOne({ uid: uid.toUpperCase() });
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
  
       
        res.json({
            uid: user.uid,
            name: user.name,
            tg_username: user.tg_username
        });
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
});





app.post('/api/request-help', async (req, res) => {
    const { table_no, user_name, user_tg } = req.body;

    if (!table_no || !user_name || !user_tg) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const request_number = await generateRequestNumber();

        
        const newRequest = new Request({
            request_number,
            table_no,
            user_name,
            user_tg,
            status: 'pending',
        });
        await newRequest.save();

        
        const assignedMentors = await Mentor.find({ assigned_tables: table_no });
        if (assignedMentors.length === 0) {
            return res.status(404).json({ error: 'No mentors assigned to this table' });
        }

        
        for (const mentor of assignedMentors) {
            if (!mentor.telegram_id || isNaN(Number(mentor.telegram_id))) {
                console.error('Invalid or missing telegram_id for mentor:', mentor);
                continue; 
            }

            try {
                await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                    chat_id: mentor.telegram_id, 
                    text: `🚨 *Help Request*\n\n👤 User: ${user_name}\n📱 Telegram: @${user_tg}\n📍 Table: ${table_no}`,
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
            } catch (error) {
                if (error.response?.data?.description === 'Bad Request: chat not found') {
                    console.error(`Mentor ${mentor.telegram_id} has not started a conversation with the bot.`);
                } else {
                    console.error(`Error notifying mentor ${mentor.telegram_id}:`, error.response?.data || error.message);
                }
            }
        }

        res.json({ message: 'Request sent to mentors', request_number });
    } catch (error) {
        console.error('Error creating help request:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


app.post('/api/accept-request/:request_number', async (req, res) => {
    const { request_number } = req.params;
    const { mentor_tg } = req.body;

    if (!mentor_tg) {
        return res.status(400).json({ error: 'Mentor Telegram ID is required.' });
    }

    try {
       
        const request = await Request.findOneAndUpdate(
            { request_number, status: 'pending' },
            { status: 'accepted', mentor_tg },
            { new: true }
        );

        if (!request) {
            return res.status(404).json({ error: 'Request not found or already accepted.' });
        }

      
        const mentor = await Mentor.findOneAndUpdate(
            { telegram_id: mentor_tg },
            {
                $inc: { total_requests_served: 1 },
                $push: { ratings: { request_number, rating: null } },
            },
            { new: true }
        );

        if (!mentor) {
            return res.status(404).json({ error: 'Mentor not found.' });
        }

       
        try {
            if (!request.user_tg) {
                console.error('User telegram_id is missing:', request);
                return res.status(400).json({ error: 'User telegram_id is invalid' });
            }

            await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
                chat_id: request.user_tg,
                text: `✅ Your request has been accepted by Mentor ${mentor.username}. Please rate them after the session.`,
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
        } catch (error) {
            console.error('Error notifying user:', error.response?.data || error.message);
        }

        res.json({ message: `Request ${request_number} accepted by ${mentor.username}` });
    } catch (error) {
        console.error('Error accepting request:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


app.post('/api/rate-mentor', async (req, res) => {
    const { request_number, rating, halo_signature } = req.body;

    if (!request_number || !rating || !halo_signature) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    if (rating < 1 || rating > 10) {
        return res.status(400).json({ error: 'Invalid rating. Must be between 1 and 10.' });
    }

    try {
        const request = await Request.findOne({ request_number });

        if (!request || request.status !== 'accepted') {
            return res.status(404).json({ error: 'Request not found or not resolved.' });
        }

      
        const { digest } = halo_signature.input;
        const { etherAddress } = halo_signature;

        
        request.rating = rating;
        request.signature = { digest, etherAddress };
        await request.save();

        
        const mentor = await Mentor.findOneAndUpdate(
            { telegram_id: request.mentor_tg },
            { $push: { ratings: { request_number, rating } } },
            { new: true }
        );

        if (!mentor) {
            return res.status(404).json({ error: 'Mentor not found.' });
        }

        res.json({
            message: `Mentor ${request.mentor_tg} rated ${rating}, signature saved, and mentor ratings updated.`,
        });
    } catch (error) {
        console.error('Error saving rating and updating mentor ratings:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


app.get('/api/check-request/:requestNumber', async (req, res) => {
    const { requestNumber } = req.params;

    try {
        const request = await Request.findOne({ request_number: parseInt(requestNumber) });

        if (!request) {
            return res.status(404).json({ error: 'Request not found' });
        }

        return res.json({ isRated: request.rating !== null });
    } catch (error) {
        console.error('Error checking request status:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



app.post('/api/attest', async (req, res) => {
    const { digest, etherAddress, request_number } = req.body;

    if (!digest || !etherAddress || !request_number) {
        return res.status(400).json({ error: 'Missing required fields.' });
    }

    try {
        console.log("Input Data:", { digest, etherAddress, request_number });

        
      

        
        const provider = new ethers.providers.JsonRpcProvider(
            "https://sepolia.infura.io/v3/f974c32fc2af440692f1ff90f293b41e"
        );
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        const contractAddress = "0x878c92FD89d8E0B93Dc0a3c907A2adc7577e39c5";
        const contract = new Contract(contractAddress, abi, wallet);

       
        const normalizedEtherAddress = ethers.utils.getAddress(etherAddress);

        
        const encodedData = ethers.utils.defaultAbiCoder.encode(
            ["string", "address", "uint256"],
            [digest, normalizedEtherAddress, request_number]
        );

        console.log("Encoded Data:", encodedData);

        
        const tx = await contract["attest((uint64,uint64,uint64,uint64,address,uint64,uint8,bool,bytes[],bytes),string,bytes,bytes)"](
            {
                schemaId: BigNumber.from("0x301"),
                linkedAttestationId: 0,
                attestTimestamp: 0,
                revokeTimestamp: 0,
                attester: wallet.address,
                validUntil: 0,
                dataLocation: 0,
                revoked: false,
                recipients: [],
                data: encodedData,
            },
            normalizedEtherAddress.toLowerCase(), 
            "0x", 
            "0x00" 
        );

        console.log("Transaction Sent:", tx.hash);

        const receipt = await tx.wait(1); 

        console.log("Transaction Receipt:", receipt);

       
        const eventAbi = abi.find((item) => item.name === "AttestationMade" && item.type === "event");
        const eventInterface = new ethers.utils.Interface([eventAbi]);
        const attestationEvent = receipt.events.find((event) => {
            try {
                const decodedEvent = eventInterface.parseLog(event);
                return decodedEvent.name === "AttestationMade";
            } catch {
                return false;
            }
        });

        let attestationId = null;

        if (attestationEvent) {
            const decoded = eventInterface.parseLog(attestationEvent);
            attestationId = decoded.args.attestationId.toString();
        }

        
        await Request.findOneAndUpdate(
            { request_number },
            {
                transactionHash: receipt.transactionHash,
                attestationId: attestationId,
            },
            { new: true }
        );

        return res.json({
            transactionHash: receipt.transactionHash,
            attestationId,
            message: "Attestation completed and request updated successfully.",
        });
    } catch (error) {
        console.error("Error in attest API:", error);
        return res.status(500).json({ error: "Internal server error", details: error.message });
    }
});


app.get('/api/leaderboard', async (req, res) => {
    try {
        const mentors = await Mentor.find();

        const leaderboard = mentors.map(mentor => {
          
            const validRatings = mentor.ratings
                .filter(r => r.rating !== null)
                .map(r => r.rating);

            const reputation = validRatings.length > 0
                ? validRatings.reduce((sum, rating) => sum + rating, 0) / validRatings.length
                : 0;

            return {
                username: mentor.username,
                reputation: reputation.toFixed(2),
            };
        });

        
        leaderboard.sort((a, b) => b.reputation - a.reputation);

        res.json(leaderboard);
    } catch (error) {
        console.error('Error fetching leaderboard data:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});


const PORT = process.env.PORT || 3000; 
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

