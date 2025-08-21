// app.js

const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const express = require('express');
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, getDoc, setDoc, collection, addDoc, query, where, getDocs, updateDoc, Timestamp } = require('firebase/firestore');
const { getAuth, signInAnonymously, signInWithCustomToken } = require('firebase/auth');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const firebaseConfigRaw = process.env.FIREBASE_CONFIG;
let firebaseConfig = {};
try {
    if (firebaseConfigRaw) {
        firebaseConfig = JSON.parse(firebaseConfigRaw);
    }
} catch (e) {
    console.error("Error parsing FIREBASE_CONFIG environment variable:", e);
    console.log("Raw FIREBASE_CONFIG string:", firebaseConfigRaw);
}

console.log("Parsed firebaseConfig object:", firebaseConfig);

const appId = process.env.__APP_ID || 'default-app-id';
const initialAuthToken = process.env.FIREBASE_AUTH_TOKEN || null;

let db;
let auth;
let userId;
let isOwnerOnline = true;
let isPersonalAssistantMode = false;
let qrCodeData = 'QR code is not generated yet. Please wait...';
let isClientReady = false;
let savedSession = null;
let schedulerInterval;

if (Object.keys(firebaseConfig).length > 0) {
    try {
        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        auth = getAuth(firebaseApp);

        const signInUser = async () => {
            try {
                if (initialAuthToken) {
                    const userCredential = await signInWithCustomToken(auth, initialAuthToken);
                    userId = userCredential.user.uid;
                } else {
                    const userCredential = await signInAnonymously(auth);
                    userId = userCredential.user.uid;
                }
                console.log("Firebase प्रमाणित। User ID:", userId);
                await loadBotConfigFromFirestore();
            } catch (error) {
                console.error("Firebase प्रमाणीकरण त्रुटि:", error);
                userId = crypto.randomUUID();
                console.warn("अनाधिकारिक यूजर ID का उपयोग कर रहे हैं:", userId);
            }
        };
        signInUser();
    } catch (error) {
        console.error("Firebase इनिशियलाइज़ करने में विफल:", error);
    }
} else {
    console.warn("Firebase कॉन्फ़िग नहीं मिली। स्टेट स्थायी नहीं होगा। कृपया FIREBASE_CONFIG env var सेट करें।");
    userId = crypto.randomUUID();
}

async function loadBotConfigFromFirestore() {
    if (!db || !userId) return;
    const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/whatsappBotConfig`, 'status');
    try {
        const docSnap = await getDoc(configDocRef);
        if (docSnap.exists()) {
            const data = docSnap.data();
            isOwnerOnline = data.isOwnerOnline !== undefined ? data.isOwnerOnline : true;
            isPersonalAssistantMode = data.isPersonalAssistantMode !== undefined ? data.isPersonalAssistantMode : false;
            qrCodeData = data.lastQrCodeData || 'QR code is not generated yet. Please wait...';
            savedSession = data.session ? JSON.parse(data.session) : null;
            console.log(`Firestore से बॉट कॉन्फ़िग लोड हुआ: मालिक ऑनलाइन=${isOwnerOnline}, पर्सनल असिस्टेंट मोड=${isPersonalAssistantMode}, सेशन मौजूद=${!!savedSession}`);
        } else {
            isOwnerOnline = true;
            isPersonalAssistantMode = false;
            qrCodeData = 'QR code is not generated yet. Please wait...';
            savedSession = null;
            await setDoc(configDocRef, {
                isOwnerOnline: true,
                isPersonalAssistantMode: false,
                lastQrCodeData: qrCodeData,
                session: null
            });
            console.log("बॉट कॉन्फ़िग Firestore में इनिशियलाइज़ की गई");
        }
    } catch (error) {
        console.error("Firestore से बॉट कॉन्फ़िग लोड में त्रुटि:", error);
    }
}

async function saveBotConfigToFirestore() {
    if (!db || !userId) return;
    const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/whatsappBotConfig`, 'status');
    try {
        const sessionToSave = (typeof savedSession === 'object' && savedSession !== null && Object.keys(savedSession).length > 0)
            ? JSON.stringify(savedSession)
            : null;
        await setDoc(configDocRef, {
            isOwnerOnline,
            isPersonalAssistantMode,
            lastQrCodeData: qrCodeData,
            session: sessionToSave
        });
        console.log("बॉट कॉन्फ़िग Firestore में सहेजी गई");
    } catch (error) {
        console.error("Firestore में बॉट कॉन्फ़िग सहेजने में त्रुटि:", error);
    }
}

// IST timezone में datetime-local input लेकर UTC में कन्वर्ट करने वाला फंक्शन
function parseScheduleDetails(data, currentSenderId) {
    let message, recipientRaw, timeString;
    if (typeof data === 'string') {
        const regex = /^send\s+(.+)\s+to\s+([0-9+]+)\s+at\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)$/i;
        const match = data.match(regex);
        if (!match) return null;
        [, message, recipientRaw, timeString] = match;
    } else {
        message = data.message;
        recipientRaw = data.recipientNumber;
        timeString = data.scheduledTime;
    }

    let recipient = recipientRaw.replace(/\D/g, '');
    if (recipient.startsWith('0')) recipient = recipient.substring(1);
    if (recipient.length === 10 && !recipient.startsWith('91')) recipient = '91' + recipient;
    recipient = `${recipient}@c.us`;

    const now = new Date();
    let scheduledDate;

    if (timeString.includes('T') && !timeString.endsWith('Z')) {
        const [datePart, timePart] = timeString.split('T');
        const [hourStr, minuteStr] = timePart.split(':');
        const hour = parseInt(hourStr, 10);
        const minute = parseInt(minuteStr, 10);

        scheduledDate = new Date(Date.UTC(
            parseInt(datePart.substr(0, 4), 10),
            parseInt(datePart.substr(5, 2), 10) - 1,
            parseInt(datePart.substr(8, 2), 10),
            hour - 5,
            minute - 30,
            0, 0
        ));
    } else {
        scheduledDate = new Date();
        let [hours, minutes] = [0, 0];
        const timeMatch = timeString.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
            hours = parseInt(timeMatch[1], 10);
            minutes = timeMatch ? parseInt(timeMatch, 10) : 0;
            const ampm = timeMatch?.toLowerCase();
            if (ampm === 'pm' && hours !== 12) hours += 12;
            else if (ampm === 'am' && hours === 12) hours = 0;
        } else {
            console.warn("Could not parse time string:", timeString);
            return null;
        }
        scheduledDate.setHours(hours, minutes, 0, 0);
    }

    if (scheduledDate.getTime() <= now.getTime()) {
        scheduledDate.setDate(scheduledDate.getDate() + 1);
    }

    return {
        recipient,
        message,
        scheduledTime: scheduledDate.toISOString(),
        status: 'pending',
        requesterId: currentSenderId
    };
}

async function scheduleMessageInFirestore(scheduleDetails) {
    if (!db || !userId) return false;
    const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
    try {
        await addDoc(scheduledMessagesRef, {
            recipient: scheduleDetails.recipient,
            message: scheduleDetails.message,
            scheduledTime: scheduleDetails.scheduledTime,
            status: 'pending',
            createdAt: Timestamp.now(),
            requesterId: scheduleDetails.requesterId
        });
        return true;
    } catch (error) {
        console.error("शेड्यूल किया गया मैसेज Firestore में सेव में त्रुटि:", error);
        return false;
    }
}

async function sendScheduledMessages() {
    if (!db || !userId || !isClientReady) return;

    const now = new Date();
    const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
    const q = query(scheduledMessagesRef, where('status', '==', 'pending'));

    try {
        const querySnapshot = await getDocs(q);
        const messagesToSend = [];
        querySnapshot.forEach(docSnap => {
            const data = docSnap.data();
            const scheduledTime = new Date(data.scheduledTime);
            if (scheduledTime.getTime() <= now.getTime()) {
                messagesToSend.push({ id: docSnap.id, ...data });
            }
        });

        for (const msgData of messagesToSend) {
            try {
                let recipientToSend = msgData.recipient;
                if (!recipientToSend.endsWith('@c.us') && !recipientToSend.endsWith('@g.us')) {
                    recipientToSend = `${recipientToSend}@c.us`;
                }
                await client.sendMessage(recipientToSend, msgData.message);
                await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/scheduledMessages`, msgData.id), {
                    status: 'sent',
                    sentAt: Timestamp.now()
                });

                if (msgData.requesterId && msgData.requesterId !== recipientToSend && client.info?.wid?._serialized) {
                    await client.sendMessage(msgData.requesterId, `आपका शेड्यूल किया गया मैसेज "${msgData.message}" को ${msgData.recipient} पर भेज दिया गया है।`);
                }
            } catch (sendError) {
                await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/scheduledMessages`, msgData.id), {
                    status: 'failed',
                    error: sendError.message,
                    sentAt: Timestamp.now()
                });
                if (msgData.requesterId && client.info?.wid?._serialized) {
                    await client.sendMessage(msgData.requesterId, `शेड्यूल मैसेज भेजने में त्रुटि: ${sendError.message}`);
                }
            }
        }
    } catch (error) {
        console.error("शेड्यूल मैसेज प्रोसेसिंग त्रुटि:", error);
    }
}

let client;

function initializeWhatsappClient() {
    console.log("WhatsApp क्लाइंट इनिशियलाइज़ कर रहे हैं...");
    const clientOptions = {
        puppeteer: {
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--single-process',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding'
            ],
        }
    };

    if (savedSession) {
        clientOptions.session = savedSession;
        console.log('सेव्ड सेशन के साथ क्लाइंट इनिशियलाइज़ करने का प्रयास कर रहे हैं...');
    } else {
        console.log('कोई सेव्ड सेशन नहीं मिला, QR कोड के लिए क्लाइंट इनिशियलाइज़ करेंगे...');
    }

    client = new Client(clientOptions);

    client.on('qr', async qr => {
        console.log('QR कोड प्राप्त हुआ।');
        qrCodeData = await qrcode.toDataURL(qr);
        await saveBotConfigToFirestore();
    });

    client.on('ready', async () => {
        isClientReady = true;
        console.log('WhatsApp क्लाइंट तैयार है!');
        await new Promise(resolve => setTimeout(resolve, 1000));

        const botOwnId = client.info?.wid?._serialized || null;
        if (botOwnId) {
            try {
                await client.sendMessage(botOwnId, 'बॉट सफलतापूर्वक कनेक्ट हो गया है!');
                console.log(`कनेक्शन कन्फर्मेशन मैसेज ${botOwnId} को भेजा गया।`);
            } catch (error) {
                console.error('कनेक्शन कन्फर्मेशन मैसेज भेजने में त्रुटि:', error);
            }
        } else {
            console.warn('client.info.wid उपलब्ध नहीं है।');
        }

        if (schedulerInterval) clearInterval(schedulerInterval);
        schedulerInterval = setInterval(sendScheduledMessages, 60 * 1000);
    });

    client.on('authenticated', async session => {
        console.log('WhatsApp क्लाइंट प्रमाणित हुआ!');
        if (session && typeof session === 'object' && Object.keys(session).length > 0) {
            savedSession = session;
            console.log("Session saved.");
        } else {
            savedSession = null;
            console.error("Session ऑब्जेक्ट अमान्य है।");
        }
        qrCodeData = 'WhatsApp क्लाइंट प्रमाणित है और ऑनलाइन है!';
        await saveBotConfigToFirestore();
    });

    client.on('auth_failure', async msg => {
        console.error('प्रमाणीकरण विफल:', msg);
        qrCodeData = 'प्रमाणीकरण विफल हुआ। कृपया पुनः QR स्कैन करें।';
        savedSession = null;
        await saveBotConfigToFirestore();
        if (schedulerInterval) clearInterval(schedulerInterval);
        if (client) {
            try { await client.destroy(); } catch {}
        }
    });

    client.on('disconnected', async reason => {
        console.log('WhatsApp डिस्कनेक्ट:', reason);
        savedSession = null;
        qrCodeData = 'QR कोड स्कैन करें।';
        await saveBotConfigToFirestore();
        isClientReady = false;
        if (schedulerInterval) clearInterval(schedulerInterval);
        if (client) {
            try { await client.destroy(); } catch {}
        }
        console.log("WhatsApp क्लाइंट पुनः इनिशियलाइज़ कर रहे हैं...");
        initializeWhatsappClient();
    });

    client.on('message', async msg => {
        if (msg.fromMe) return;
        const senderId = msg.from;
        const botOwnId = client.info?.wid?._serialized || null;
        const messageBody = msg.body;

        if (senderId !== botOwnId) {
            console.log(`मैसेज मालिक से नहीं आया (${senderId}), जवाब नहीं देगा।`);
            return;
        }

        const lower = messageBody.toLowerCase().trim();

        if (lower.startsWith('send ')) {
            const scheduleDetails = parseScheduleDetails(messageBody, senderId);
            if (scheduleDetails) {
                const success = await scheduleMessageInFirestore(scheduleDetails);
                if (success) {
                    await client.sendMessage(senderId, `शेड्यूल्ड: "${scheduleDetails.message}" को ${scheduleDetails.recipient.split('@')[0]} पर ${new Date(scheduleDetails.scheduledTime).toLocaleString()} भेजा जाएगा।`);
                } else {
                    await client.sendMessage(senderId, 'शेड्यूल सेव करने में त्रुटि।');
                }
            } else {
                await client.sendMessage(senderId, 'गलत फॉर्मैट। उपयोग करें: send [मैसेज] to [नंबर] at [समय]');
            }
            return;
        }

        if (lower === 'online true') {
            isOwnerOnline = true;
            await saveBotConfigToFirestore();
            await client.sendMessage(senderId, 'स्थिति: ऑनलाइन।');
            return;
        } else if (lower === 'online false') {
            isOwnerOnline = false;
            await saveBotConfigToFirestore();
            await client.sendMessage(senderId, 'स्थिति: ऑफ़लाइन।');
            return;
        } else if (lower === 'assistant on') {
            isPersonalAssistantMode = true;
            await saveBotConfigToFirestore();
            await client.sendMessage(senderId, 'पर्सनल असिस्टेंट मोड चालू।');
            return;
        } else if (lower === 'assistant off') {
            isPersonalAssistantMode = false;
            await saveBotConfigToFirestore();
            await client.sendMessage(senderId, 'पर्सनल असिस्टेंट मोड बंद।');
            return;
        }

        if (isPersonalAssistantMode) {
            await handleBotResponse(msg);
        }
    });

    client.initialize();
}

async function handleBotResponse(msg) {
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
    let replyText = 'माफ़ करें, अभी उत्तर देने में समस्या है।';
    if (!GEMINI_API_KEY) {
        replyText = 'Gemini API की चाबी सेट नहीं है।';
    } else {
        try {
            const prompt = `उपयोगकर्ता के इस संदेश का एक छोटा, दोस्ताना और सीधा जवाब दें, जैसे कोई आम इंसान देता। संदेश: "${msg.body}"`;
            const payload = {
                contents: [
                    {
                        role: "user",
                        parts: [
                            { text: prompt }
                        ]
                    }
                ]
            };
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;
            let response, result;
            let retries = 0;
            while (retries < 5) {
                try {
                    response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    result = await response.json();
                    if (result.candidates?.length > 0 && result.candidates[0].content?.parts?.length > 0) {
                        replyText = result.candidates.content.parts.text;
                        break;
                    } else {
                        replyText = 'क्षमा करें, मैं समझ नहीं पाया।';
                        break;
                    }
                } catch (e) {
                    retries++;
                    if (retries === 5) replyText = 'तकनीकी समस्या आई है।';
                    else await new Promise(r => setTimeout(r, Math.pow(2, retries) * 1000));
                }
            }
        } catch {
            replyText = 'तकनीकी त्रुटि हुई।';
        }
    }
    await msg.reply(replyText);
}

app.get('/', async (req, res) => {
    if (db && userId) await loadBotConfigFromFirestore();

    if (isClientReady) {
        res.send(`
            <!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>WhatsApp पर्सनल असिस्टेंट</title><script src="https://cdn.tailwindcss.com"></script></head><body class="bg-gray-100 p-4 flex justify-center items-center min-h-screen text-gray-800 font-sans"><div class="bg-white rounded p-8 shadow max-w-md w-full text-center">
            <h1 class="text-3xl font-bold mb-4 text-green-600">WhatsApp बॉट तैयार है!</h1>
            <p>स्थिति: <strong class="${isOwnerOnline ? 'text-green-600' : 'text-red-600'}">${isOwnerOnline ? 'ऑनलाइन' : 'ऑफ़लाइन'}</strong></p>
            <p>पर्सनल असिस्टेंट मोड: <strong class="${isPersonalAssistantMode ? 'text-green-600' : 'text-red-600'}">${isPersonalAssistantMode ? 'चालू' : 'बंद'}</strong></p>
            <div class="mt-6 space-y-4">
                <a href="/toggle_owner_status" class="block bg-blue-500 text-white py-3 rounded hover:bg-blue-600 transition">मालिक स्थिति टॉगल करें</a>
                <a href="/toggle_personal_assistant" class="block bg-purple-500 text-white py-3 rounded hover:bg-purple-600 transition">पर्सनल असिस्टेंट मोड टॉगल करें</a>
                <a href="/logout" class="block bg-red-500 text-white py-3 rounded hover:bg-red-600 transition">WhatsApp लॉगआउट</a>
                <a href="/schedule" class="block bg-green-500 text-white py-3 rounded hover:bg-green-600 transition">शेड्यूल मैसेज देखें/सेट करें</a>
            </div>
        </div></body></html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html><html lang="hi"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>QR कोड स्कैन करें</title></head><body class="bg-gray-100 p-4 flex justify-center items-center min-h-screen text-gray-800 font-sans"><div class="bg-white rounded p-8 shadow max-w-md w-full text-center">
            <h1 class="text-3xl font-bold mb-4 text-blue-600">QR कोड स्कैन करें</h1>
            <p>WhatsApp खोलें, Linked Devices पर जाएं, नीचे QR कोड स्कैन करें।</p>
            <img style="max-width:80%;margin:1rem auto;display:block;" src="${qrCodeData}" alt="QR Code" />
        </div></body></html>
        `);
    }
});

app.get('/ping', (req, res) => {
    res.send('OK');
});

app.get('/schedule', async (req, res) => {
    let messages = [];
    if (db && userId) {
        const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
        const querySnapshot = await getDocs(scheduledMessagesRef);
        querySnapshot.forEach(doc => {
            let data = doc.data();
            if (data.createdAt instanceof Timestamp) data.createdAt = data.createdAt.toDate().toISOString();
            if (data.sentAt instanceof Timestamp) data.sentAt = data.sentAt.toDate().toISOString();
            messages.push({ id: doc.id, ...data });
        });
        messages.sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
    }

    res.send(`
    <!DOCTYPE html>
    <html lang="hi">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Scheduled Messages</title>
        <script src="https://cdn.tailwindcss.com"></script>
    </head>
    <body class="bg-gray-100 min-h-screen flex flex-col items-center py-8 font-sans text-gray-800">
        <div class="bg-white shadow-lg rounded-lg p-8 w-full max-w-3xl">
            <h1 class="text-2xl font-bold mb-6 text-center text-green-700">Scheduled Messages</h1>

            <div class="overflow-x-auto max-h-96 mb-8">
                <table class="min-w-full border border-gray-300 rounded-lg table-auto">
                    <thead class="bg-green-100 sticky top-0">
                        <tr>
                            <th class="px-4 py-2 border border-gray-300 text-left">Recipient</th>
                            <th class="px-4 py-2 border border-gray-300 text-left">Message</th>
                            <th class="px-4 py-2 border border-gray-300 text-left">Status</th>
                            <th class="px-4 py-2 border border-gray-300 text-left">Scheduled Time (IST)</th>
                            <th class="px-4 py-2 border border-gray-300 text-left">Sent Time (IST)</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${messages.length === 0 
                            ? `<tr><td colspan="5" class="text-center p-4 text-gray-500">कोई शेड्यूल किया गया मैसेज नहीं मिला।</td></tr>` 
                            : messages.map(m => `
                                <tr class="hover:bg-green-50">
                                    <td class="border border-gray-300 px-4 py-2">${m.recipient}</td>
                                    <td class="border border-gray-300 px-4 py-2 break-words max-w-xs">${m.message}</td>
                                    <td class="border border-gray-300 px-4 py-2 capitalize">${m.status}</td>
                                    <td class="border border-gray-300 px-4 py-2">${new Date(m.scheduledTime).toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' })}</td>
                                    <td class="border border-gray-300 px-4 py-2">${m.sentAt ? new Date(m.sentAt).toLocaleString('hi-IN', { timeZone: 'Asia/Kolkata' }) : '—'}</td>
                                </tr>
                            `).join('')}
                    </tbody>
                </table>
            </div>

            <form method="POST" action="/schedule_message" class="space-y-4 max-w-xl mx-auto">
                <div>
                    <label for="recipientNumber" class="block mb-1 font-medium">प्राप्तकर्ता नंबर (देश कोड सहित)</label>
                    <input id="recipientNumber" name="recipientNumber" type="text" required placeholder="उदा: 919876543210" 
                        class="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
                </div>
                <div>
                    <label for="message" class="block mb-1 font-medium">मैसेज</label>
                    <textarea id="message" name="message" rows="3" required placeholder="यहाँ मैसेज लिखें" 
                        class="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500"></textarea>
                </div>
                <div>
                    <label for="scheduledTime" class="block mb-1 font-medium">शेड्यूल्ड समय</label>
                    <input id="scheduledTime" name="scheduledTime" type="datetime-local" required 
                        class="w-full border border-gray-300 rounded px-3 py-2 focus:outline-none focus:ring-2 focus:ring-green-500" />
                    <p class="text-sm mt-1 text-gray-600">समय भारतीय मानक समय (IST) में भरें</p>
                </div>
                <button type="submit" 
                    class="w-full bg-green-600 text-white py-3 rounded hover:bg-green-700 transition font-semibold">
                    मैसेज शेड्यूल करें
                </button>
            </form>

            <div class="mt-6 text-center">
                <a href="/" class="text-green-600 hover:underline font-medium">मुख्य पेज पर जाएं</a>
            </div>
        </div>
    </body>
    </html>
    `);
});

app.post('/schedule_message', async (req, res) => {
    if (!db || !userId) return res.status(500).json({ success: false, message: "Firebase या यूजर ID उपलब्ध नहीं।" });
    const { recipientNumber, message, scheduledTime } = req.body;
    if (!recipientNumber || !message || !scheduledTime) return res.status(400).json({ success: false, message: "सभी फ़ील्ड भरें।" });
    const botOwnId = client.info?.wid?._serialized || userId;
    const scheduleDetails = parseScheduleDetails({ recipientNumber, message, scheduledTime }, botOwnId);
    if (!scheduleDetails) return res.status(400).json({ success: false, message: "अवैध नंबर या समय फॉर्मेट।" });
    const success = await scheduleMessageInFirestore(scheduleDetails);
    if (success) return res.json({ success: true, message: "मैसेज शेड्यूल किया गया!" });
    else return res.status(500).json({ success: false, message: "शेड्यूल सेव करने में त्रुटि।" });
});

app.get('/toggle_owner_status', async (req, res) => {
    if (!db || !userId) return res.status(500).send("Firebase या यूजर ID उपलब्ध नहीं।");
    isOwnerOnline = !isOwnerOnline;
    await saveBotConfigToFirestore();
    res.redirect('/');
});

app.get('/toggle_personal_assistant', async (req, res) => {
    if (!db || !userId) return res.status(500).send("Firebase या यूजर ID उपलब्ध नहीं।");
    isPersonalAssistantMode = !isPersonalAssistantMode;
    await saveBotConfigToFirestore();
    res.redirect('/');
});

app.get('/logout', async (req, res) => {
    if (client && isClientReady) {
        await client.logout();
        savedSession = null;
        qrCodeData = 'QR code is not generated yet. Please wait...';
        await saveBotConfigToFirestore();
        isClientReady = false;
        if (schedulerInterval) clearInterval(schedulerInterval);
        res.redirect('/');
    } else {
        res.status(400).send('WhatsApp क्लाइंट तैयार नहीं या पहले से लॉगआउट है।');
    }
});

app.get('/api/scheduled-messages', async (req, res) => {
    if (!db || !userId) return res.status(500).json({ error: "Firebase या यूजर ID उपलब्ध नहीं।" });
    try {
        const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
        const querySnapshot = await getDocs(scheduledMessagesRef);
        const messages = [];
        querySnapshot.forEach(doc => {
            const data = doc.data();
            if (data.createdAt instanceof Timestamp) data.createdAt = data.createdAt.toDate().toISOString();
            if (data.sentAt instanceof Timestamp) data.sentAt = data.sentAt.toDate().toISOString();
            messages.push({ id: doc.id, ...data });
        });
        messages.sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
        res.json(messages);
    } catch (error) {
        res.status(500).json({ error: "शेड्यूल्ड मैसेज प्राप्त करने में त्रुटि।" });
    }
});

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

initializeWhatsappClient();
