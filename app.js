// app.js

// आवश्यक लाइब्रेरी आयात करें
const { Client } = require('whatsapp-web.js');
const qrcode = require('qrcode'); // QR कोड जेनरेट करने के लिए
const express = require('express'); // एक वेब सर्वर बनाने के लिए
const { initializeApp } = require('firebase/app'); // Firebase ऐप इनिशियलाइज़ करने के लिए
const { getFirestore, doc, getDoc, setDoc, collection, addDoc, query, where, getDocs, updateDoc, Timestamp } = require('firebase/firestore'); // Firestore संचालन के लिए
const { getAuth, signInAnonymously, signInWithCustomToken } = require('firebase/auth'); // Firebase प्रमाणीकरण के लिए

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
                console.warn("अनाधिकारिक यूजर ID का उपयोग कर रहे हैं (Firebase कॉन्फ़िग या टोकन समस्या हो सकती है):", userId);
            }
        };
        signInUser();
    } catch (error) {
        console.error("Firebase इनिशियलाइज़ करने में विफल:", error);
    }
} else {
    console.warn("Firebase कॉन्फ़िग नहीं मिली। स्थिति स्थायी नहीं होगी। कृपया Render में FIREBASE_CONFIG env var सेट करें।");
    userId = crypto.randomUUID();
}

async function loadBotConfigFromFirestore() {
    if (!db || !userId) {
        console.warn("Firestore या User ID उपलब्ध नहीं, कॉन्फ़िग लोड नहीं हो सकती।");
        return;
    }
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
            await setDoc(configDocRef, { isOwnerOnline: true, isPersonalAssistantMode: false, lastQrCodeData: qrCodeData, session: null });
            console.log("बॉट कॉन्फ़िग Firestore में इनिशियलाइज़ की गई: मालिक ऑनलाइन, पर्सनल असिस्टेंट मोड ऑफ, कोई सेशन नहीं।");
        }
    } catch (error) {
        console.error("Firestore से बॉट कॉन्फ़िग लोड करने में त्रुटि:", error);
    }
}

async function saveBotConfigToFirestore() {
    if (!db || !userId) {
        console.warn("Firestore या User ID उपलब्ध नहीं, कॉन्फ़िग सहेजी नहीं जा सकती।");
        return;
    }
    const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/whatsappBotConfig`, 'status');
    try {
        const sessionToSave = (typeof savedSession === 'object' && savedSession !== null && Object.keys(savedSession).length > 0)
                               ? JSON.stringify(savedSession)
                               : null;
        console.log("Saving session to Firestore. Session exists:", !!savedSession);
        await setDoc(configDocRef, {
            isOwnerOnline,
            isPersonalAssistantMode,
            lastQrCodeData: qrCodeData,
            session: sessionToSave
        });
        console.log(`बॉट कॉन्फ़िग Firestore में सहेजी गई: मालिक ऑनलाइन=${isOwnerOnline}, पर्सनल असिस्टेंट मोड=${isPersonalAssistantMode}, सेशन सेव्ड=${!!sessionToSave}`);
    } catch (error) {
        console.error("Firestore में बॉट कॉन्फ़िग सहेजने में त्रुटि:", error);
    }
}

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
    if (recipient.startsWith('0')) {
        recipient = recipient.substring(1);
    }
    if (recipient.length === 10 && !recipient.startsWith('91')) {
        recipient = '91' + recipient;
    }
    recipient = `${recipient}@c.us`;

    const now = new Date();
    let scheduledDate = new Date();

    if (timeString.includes('T')) {
        scheduledDate = new Date(timeString);
    } else {
        let [hours, minutes] = [0, 0];
        const timeMatch = timeString.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
        if (timeMatch) {
            hours = parseInt(timeMatch[1], 10);
            minutes = timeMatch ? parseInt(timeMatch, 10) : 0;
            const ampm = timeMatch?.toLowerCase();

            if (ampm === 'pm' && hours !== 12) {
                hours += 12;
            } else if (ampm === 'am' && hours === 12) {
                hours = 0;
            }
        } else {
            console.warn("Could not parse time string:", timeString);
            return null;
        }
        scheduledDate.setHours(hours, minutes, 0, 0);
    }

    if (scheduledDate.getTime() <= now.getTime()) {
        scheduledDate.setDate(scheduledDate.getDate() + 1);
        console.log(`Scheduled time (${timeString}) is in the past today, scheduling for tomorrow.`);
    }

    console.log(`पार्स किया गया शेड्यूल: मैसेज="${message}", प्राप्तकर्ता="${recipient}", समय="${scheduledDate.toISOString()}"`);
    return {
        recipient: recipient,
        message: message,
        scheduledTime: scheduledDate.toISOString(),
        status: 'pending',
        requesterId: currentSenderId
    };
}

async function scheduleMessageInFirestore(scheduleDetails) {
    if (!db || !userId) {
        console.warn("Firestore या User ID उपलब्ध नहीं, शेड्यूल सेव नहीं हो सकता।");
        return false;
    }
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
        console.log("शेड्यूल किया गया मैसेज Firestore में सफलतापूर्वक सेव हुआ।");
        return true;
    } catch (error) {
        console.error("शेड्यूल किया गया मैसेज Firestore में सेव करने में त्रुटि:", error);
        return false;
    }
}

async function sendScheduledMessages() {
    if (!db || !userId || !isClientReady) {
        console.log("शेड्यूलर: Firestore, User ID या WhatsApp क्लाइंट तैयार नहीं।");
        return;
    }

    console.log("शेड्यूलर: भेजने के लिए लंबित मैसेजेस की जाँच कर रहा है...");
    const now = new Date();
    const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
    const q = query(
        scheduledMessagesRef,
        where('status', '==', 'pending')
    );

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

        if (messagesToSend.length === 0) {
            console.log("शेड्यूलर: भेजने के लिए कोई लंबित मैसेज नहीं मिला।");
            return;
        }

        console.log(`शेड्यूलर: भेजने के लिए ${messagesToSend.length} मैसेज मिले।`);

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
                console.log(`शेड्यूल किया गया मैसेज "${msgData.message}" को ${msgData.recipient} पर सफलतापूर्वक भेजा गया।`);

                if (msgData.requesterId && msgData.requesterId !== recipientToSend && client.info?.wid?._serialized) {
                    await client.sendMessage(msgData.requesterId, `आपका शेड्यूल किया गया मैसेज "${msgData.message}" को ${msgData.recipient} पर सफलतापूर्वक भेज दिया गया है।`);
                }

            } catch (sendError) {
                console.error(`शेड्यूल किया गया मैसेज ${msgData.id} भेजने में त्रुटि:`, sendError);
                await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/scheduledMessages`, msgData.id), {
                    status: 'failed',
                    error: sendError.message,
                    sentAt: Timestamp.now()
                });
                if (msgData.requesterId && client.info?.wid?._serialized) {
                    await client.sendMessage(msgData.requesterId, `आपका शेड्यूल किया गया मैसेज "${msgData.message}" को ${msgData.recipient} पर भेजने में त्रुटि हुई: ${sendError.message}`);
                }
            }
        }
    } catch (error) {
        console.error("शेड्यूल किए गए मैसेजेस को प्रोसेस करने में त्रुटि:", error);
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
                '--disable-gpu'
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
        console.log('QR कोड प्राप्त हुआ। इसे वेब पेज पर प्रदर्शित किया जाएगा और Firestore में सहेजा जाएगा।');
        qrCodeData = await qrcode.toDataURL(qr);
        await saveBotConfigToFirestore();
    });

    client.on('ready', async () => {
        isClientReady = true;
        console.log('WhatsApp क्लाइंट तैयार है! बॉट अब काम कर रहा है।');
        await new Promise(resolve => setTimeout(resolve, 1000));

        const botOwnId = client.info?.wid?._serialized || null;
        if (botOwnId) {
            try {
                await client.sendMessage(botOwnId, 'बॉट सफलतापूर्वक कनेक्ट हो गया है और अब आपके पर्सनल असिस्टेंट के रूप में कार्य करने के लिए तैयार है!');
                console.log(`कनेक्शन कन्फर्मेशन मैसेज ${botOwnId} को भेजा गया।`);
            } catch (error) {
                console.error('कनेक्शन कन्फर्मेशन मैसेज भेजने में त्रुटि:', error);
            }
        } else {
            console.warn('client.info.wid उपलब्ध नहीं है जब क्लाइंट तैयार है। कुछ WhatsApp ID-आधारित संचार विफल हो सकता है।');
        }

        if (schedulerInterval) {
            clearInterval(schedulerInterval);
        }
        schedulerInterval = setInterval(sendScheduledMessages, 60 * 1000);
        console.log("शेड्यूल किए गए मैसेज भेजने के लिए शेड्यूलर शुरू किया गया।");
    });

    client.on('authenticated', async (session) => {
        console.log('WhatsApp क्लाइंट प्रमाणित हुआ और सेशन प्राप्त हुआ!');
        if (session && typeof session === 'object' && Object.keys(session).length > 0) {
            savedSession = session;
            console.log("Debug: savedSession assigned after authentication. Session exists:", !!savedSession);
        } else {
            savedSession = null;
            console.error("Error: 'session' object from 'authenticated' event was empty or invalid. This may cause disconnects.");
        }
        qrCodeData = 'WhatsApp क्लाइंट प्रमाणित है और ऑनलाइन है!'; 
        await saveBotConfigToFirestore();
    });

    client.on('auth_failure', async (msg) => {
        console.error('प्रमाणीकरण विफल हुआ! सेशन साफ़ कर रहे हैं...', msg);
        qrCodeData = 'प्रमाणीकरण विफल हुआ। कृपया सेवा पुनरारंभ करें और QR कोड को फिर से स्कैन करें।';
        savedSession = null;
        await saveBotConfigToFirestore();
        if (schedulerInterval) {
            clearInterval(schedulerInterval);
            console.log("शेड्यूलर बंद किया गया।");
        }
        if (client) {
            try {
                await client.destroy();
                console.log("क्लाइंट नष्ट हो गया।");
            } catch (destroyError) {
                console.error("क्लाइंट नष्ट करने में त्रुटि:", destroyError);
            }
        }
    });

    client.on('disconnected', async (reason) => {
        console.log('WhatsApp डिस्कनेक्ट हो गया:', reason);
        savedSession = null;
        qrCodeData = 'QR code is not generated yet. Please wait...';
        await saveBotConfigToFirestore();
        isClientReady = false;
        if (schedulerInterval) {
            clearInterval(schedulerInterval);
            console.log("शेड्यूलर बंद किया गया।");
        }
        if (client) {
            try {
                await client.destroy();
                console.log("क्लाइंट नष्ट हो गया।");
            } catch (destroyError) {
                console.error("क्लाइंट नष्ट करने में त्रुटि:", destroyError);
            }
        }
        console.log("WhatsApp क्लाइंट पुनः इनिशियलाइज़ कर रहे हैं...");
        initializeWhatsappClient();
    });

    client.on('message', async msg => {
        const messageBody = msg.body;
        const senderId = msg.from;
        const botOwnId = client.info?.wid?._serialized || null;

        console.log(`[मैसेज प्राप्त] ${senderId}: "${messageBody}"`);

        if (msg.fromMe) {
            return;
        }

        if (botOwnId && senderId === botOwnId) {
            const lowerCaseMessage = messageBody.toLowerCase().trim();

            if (lowerCaseMessage.startsWith('send ')) {
                const scheduleDetails = parseScheduleDetails(messageBody, senderId);
                if (scheduleDetails) {
                    const success = await scheduleMessageInFirestore(scheduleDetails);
                    if (success) {
                        await client.sendMessage(senderId, `मैसेज "${scheduleDetails.message}" को ${scheduleDetails.recipient.split('@')[0]} पर ${new Date(scheduleDetails.scheduledTime).toLocaleString()} पर भेजने के लिए शेड्यूल किया गया है।`);
                    } else {
                        await client.sendMessage(senderId, 'शेड्यूल किया गया मैसेज सेव करने में त्रुटि हुई।');
                    }
                } else {
                    await client.sendMessage(senderId, 'क्षमा करें, आपके शेड्यूल कमांड का फॉर्मेट गलत है। कृपया "send [मैसेज] to [नंबर] at [समय]" का उपयोग करें। उदाहरण: "send Hi to 9365374458 at 12:00pm"');
                }
                return;
            }

            if (lowerCaseMessage === 'online true') {
                if (!isOwnerOnline) {
                    isOwnerOnline = true;
                    await saveBotConfigToFirestore();
                    await client.sendMessage(senderId, 'आपकी स्थिति अब: ऑनलाइन। बॉट अन्य यूज़र्स को जवाब नहीं देगा।');
                    console.log("मालिक ने अपनी स्थिति ऑनलाइन पर सेट की।");
                } else {
                    await client.sendMessage(senderId, 'आप पहले से ही ऑनलाइन हैं।');
                }
                return;
            } else if (lowerCaseMessage === 'online false') {
                if (isOwnerOnline) {
                    isOwnerOnline = false;
                    await saveBotConfigToFirestore();
                    await client.sendMessage(senderId, 'आपकी स्थिति अब: ऑफ़लाइन। बॉट अब किसी भी यूज़र को जवाब नहीं देगा, सिवाय आपके निर्देशों का पालन करने और शेड्यूल किए गए मैसेजेस भेजने के के।');
                    console.log("मालिक ने अपनी स्थिति ऑफलाइन पर सेट की।");
                } else {
                    await client.sendMessage(senderId, 'आप पहले से ही ऑफ़लाइन हैं।');
                }
                return;
            } else if (lowerCaseMessage === 'assistant on') {
                if (!isPersonalAssistantMode) {
                    isPersonalAssistantMode = true;
                    await saveBotConfigToFirestore();
                    await client.sendMessage(senderId, 'आपका पर्सनल असिस्टेंट मोड अब चालू है। मैं आपके संदेशों का जवाब दूंगा।');
                    console.log("मालिक ने पर्सनल असिस्टेंट मोड चालू किया।");
                } else {
                    await client.sendMessage(senderId, 'पर्सनल असिस्टेंट मोड पहले से ही चालू है।');
                }
                return;
            } else if (lowerCaseMessage === 'assistant off') {
                if (isPersonalAssistantMode) {
                    isPersonalAssistantMode = false;
                    await saveBotConfigToFirestore();
                    await client.sendMessage(senderId, 'आपका पर्सनल असिस्टेंट मोड अब बंद है। मैं आपके संदेशों का जवाब नहीं दूंगा।');
                    console.log("मालिक ने पर्सनल असिस्टेंट मोड बंद किया।");
                } else {
                    await client.sendMessage(senderId, 'पर्सनल असिस्टेंट मोड पहले से ही बंद है।');
                }
                return;
            }

            if (isPersonalAssistantMode) {
                console.log('मालिक का मैसेज, पर्सनल असिस्टेंट मोड चालू है, बॉट जवाब देगा।');
                await handleBotResponse(msg);
                return;
            } else {
                console.log('मालिक का मैसेज, पर्सनल असिस्टेंट मोड बंद है, बॉट जवाब नहीं देगा (केवल कमांड और शेड्यूल)।');
                return;
            }
        }

        console.log(`मैसेज मालिक से नहीं आया है (${senderId}), बॉट सीधे जवाब नहीं देगा।`);
        return;
    });

    client.initialize();
}

async function handleBotResponse(msg) {
    const messageBody = msg.body;
    let botResponseText = '';
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";

    if (!GEMINI_API_KEY) {
        botResponseText = 'माफ़ करना, मैं अभी जवाब नहीं दे पा रहा हूँ। कृपया थोड़ी देर बाद फिर से कोशिश करें।';
    } else {
        try {
            const prompt = `उपयोगकर्ता के इस संदेश का एक छोटा, दोस्ताना और सीधा जवाब दें, जैसे कोई आम इंसान देगा। कोई विकल्प या सूची न दें। संदेश: "${messageBody}"`;
            let chatHistoryForGemini = [];
            chatHistoryForGemini.push({ role: "user", parts: [{ text: prompt }] });

            const payload = { contents: chatHistoryForGemini };
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;

            let response;
            let result;
            let retries = 0;
            const maxRetries = 5;
            const baseDelay = 1000;

            while (retries < maxRetries) {
                try {
                    response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    result = await response.json();
                    if (result.candidates && result.candidates.length > 0 &&
                        result.candidates[0].content && result.candidates.content.parts &&
                        result.candidates.content.parts.length > 0) {
                        botResponseText = result.candidates.content.parts.text;
                        break;
                    } else {
                        console.warn("Gemini API ने अपेक्षित संरचना या सामग्री नहीं लौटाई।", result);
                        botResponseText = 'माफ़ करना, मैं अभी आपकी बात नहीं समझ पा रहा हूँ।';
                        break;
                    }
                } catch (error) {
                    console.error(`Gemini API कॉल में त्रुटि (प्रयास ${retries + 1}/${maxRetries}):`, error);
                    retries++;
                    if (retries < maxRetries) {
                        const delay = baseDelay * Math.pow(2, retries - 1);
                        await new Promise(resolve => setTimeout(resolve, delay));
                        console.log(`Gemini API कॉल का पुनः प्रयास कर रहा है (प्रयास ${retries}/${maxRetries})...`);
                    } else {
                        botResponseText = 'माफ़ करना, कुछ तकनीकी दिक्कत आ गई है।';
                    }
                }
            }
        } catch (error) {
            console.error('बॉट मैसेज जनरेट करने या भेजने में त्रुटि:', error);
            botResponseText = 'माफ़ करना, एक तकनीकी समस्या आ गई है।';
        }
    }
    await msg.reply(botResponseText);
    console.log(`[बॉट का जवाब] ${msg.from}: "${botResponseText}"`);
}

app.get('/', async (req, res) => {
    if (db && userId) {
        await loadBotConfigFromFirestore();
    }

    if (isClientReady) {
        res.send(`
            <!DOCTYPE html>
            <html lang="hi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>WhatsApp पर्सनल असिस्टेंट</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <style>
                    body { font-family: 'Inter', sans-serif; }
                    .glow-button {
                        position: relative;
                        overflow: hidden;
                        z-index: 1;
                    }
                    .glow-button::before {
                        content: '';
                        position: absolute;
                        top: -50%;
                        left: -50%;
                        width: 200%;
                        height: 200%;
                        background: radial-gradient(circle at center, rgba(255, 255, 255, 0.2), transparent 70%);
                        transform: rotate(45deg);
                        transition: transform 0.8s ease-in-out;
                        z-index: -1;
                    }
                    .glow-button:hover::before {
                        transform: rotate(225deg);
                    }
                </style>
            </head>
            <body class="bg-gray-100 flex items-center justify-center min-h-screen text-gray-800 p-4">
                <div class="bg-white rounded-lg shadow-xl p-8 max-w-md w-full text-center">
                    <h1 class="text-3xl font-bold text-green-600 mb-4">WhatsApp बॉट तैयार है!</h1>
                    <p class="text-lg mb-2">आपकी वर्तमान स्थिति:
                        <span class="font-semibold ${isOwnerOnline ? 'text-green-500' : 'text-red-500'}">
                            ${isOwnerOnline ? 'ऑनलाइन' : 'ऑफ़लाइन'}
                        </span>
                    </p>
                    <p class="text-lg mb-2">पर्सनल असिस्टेंट मोड:
                        <span class="font-semibold ${isPersonalAssistantMode ? 'text-green-500' : 'text-red-500'}">
                            ${isPersonalAssistantMode ? 'चालू' : 'बंद'}
                        </span>
                    </p>
                    <p class="text-gray-600 mb-6">बॉट सक्रिय है और मैसेजेस को हैंडल करने के लिए तैयार है।</p>
                    <div class="space-y-4">
                        <a href="/toggle_owner_status" class="block bg-blue-500 hover:bg-blue-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300 ease-in-out transform hover:scale-105 shadow-md glow-button">
                            मालिक की स्थिति टॉगल करें (अब आप ${isOwnerOnline ? 'ऑफ़लाइन' : 'ऑनलाइन'} होंगे)
                        </a>
                        <a href="/toggle_personal_assistant" class="block bg-purple-500 hover:bg-purple-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300 ease-in-out transform hover:scale-105 shadow-md glow-button">
                            पर्सनल असिस्टेंट मोड टॉगल करें (अब ${isPersonalAssistantMode ? 'बंद' : 'चालू'} होगा)
                        </a>
                        <a href="/logout" class="block bg-red-500 hover:bg-red-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300 ease-in-out transform hover:scale-105 shadow-md glow-button">
                            WhatsApp सेशन लॉगआउट करें
                        </a>
                        <a href="/schedule" class="block bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300 ease-in-out transform hover:scale-105 shadow-md glow-button">
                            शेड्यूल मैसेज देखें / सेट करें
                        </a>
                    </div>

                    <p class="text-xs text-gray-500 mt-4">यह आपकी स्थिति और सेशन को Firestore में सहेजेगा ताकि यह स्थायी रहे।</p>
                    <p class="text-xs text-gray-500 mt-2">नोट: बॉट अन्य यूज़र्स को जवाब नहीं देगा। यह केवल आपके निर्देशों का पालन करेगा और शेड्यूल किए गए मैसेजेस भेजेगा।</p>
                    <p class="text-xs text-gray-500 mt-2">आप खुद को 'Online true', 'Online false', 'Assistant on', 'Assistant off', या 'send [मैसेज] to [नंबर] at [समय]' मैसेज भेजकर भी स्थिति बदल सकते हैं।</p>
                </div>
            </body>
            </html>
        `);
    } else {
        res.send(`
            <!DOCTYPE html>
            <html lang="hi">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <title>QR कोड स्कैन करें</title>
                <script src="https://cdn.tailwindcss.com"></script>
                <style>
                    body { font-family: 'Inter', sans-serif; }
                </style>
            </head>
            <body class="bg-gray-100 flex items-center justify-center min-h-screen text-gray-800 p-4">
                <div class="bg-white rounded-lg shadow-xl p-8 max-w-md w-full text-center">
                    <h1 class="text-3xl font-bold text-blue-600 mb-4">QR कोड स्कैन करें</h1>
                    <p class="text-lg text-gray-700 mb-6">कृपया अपने फ़ोन से WhatsApp खोलें, <b>Linked Devices</b> पर जाएं, और इस QR कोड को स्कैन करें।</p>
                    <img src="${qrCodeData}" alt="QR Code" class="mx-auto border-2 border-black p-4 rounded-lg shadow-md max-w-[80%] h-auto"/>
                    <p class="text-sm text-gray-500 mt-6">यदि QR कोड लोड नहीं हो रहा है, तो कृपया Render लॉग्स देखें और कुछ मिनट प्रतीक्षा करें। यह QR कोड Firestore में भी सहेजा गया है।</p>
                    <p class="text-xs text-red-500 mt-2">ध्यान दें: यह बॉट whatsapp-web.js लाइब्रेरी का उपयोग करता है जो QR कोड का उपयोग करता है, पेयरिंग कोड का नहीं है।</p>
                    <p class="text-xs text-gray-500 mt-2">यह ऐप अब Firebase से सेशन को लोड करने की कोशिश करेगा, ताकि आपको बार-बार QR स्कैन न करना पड़े।</p>
                </div>
            </body>
            </html>
        `);
    }
});

app.get('/ping', (req, res) => {
    res.send('OK');
});

app.post('/schedule_message', async (req, res) => {
    if (!db || !userId) {
        return res.status(500).json({ success: false, message: "Firebase इनिशियलाइज़ नहीं हुआ या यूजर ID उपलब्ध नहीं।" });
    }
    const { recipientNumber, message, scheduledTime } = req.body;
    if (!recipientNumber || !message || !scheduledTime) {
        return res.status(400).json({ success: false, message: "कृपया सभी आवश्यक फ़ील्ड भरें।" });
    }
    const botOwnId = client.info?.wid?._serialized || userId;
    const scheduleDetails = parseScheduleDetails(
        { recipientNumber, message, scheduledTime },
        botOwnId
    );
    if (scheduleDetails) {
        const success = await scheduleMessageInFirestore(scheduleDetails);
        if (success) {
            return res.json({ success: true, message: "मैसेज सफलतापूर्वक शेड्यूल किया गया!" });
        } else {
            return res.status(500).json({ success: false, message: "शेड्यूल किया गया मैसेज सेव करने में त्रुटि हुई।" });
        }
    } else {
        return res.status(400).json({ success: false, message: "अवैध नंबर या समय फॉर्मेट। कृपया सुनिश्चित करें कि नंबर देश कोड के साथ है और समय सही फॉर्मेट में है।" });
    }
});

app.get('/toggle_owner_status', async (req, res) => {
    if (!db || !userId) {
        return res.status(500).send("Firebase इनिशियलाइज़ नहीं हुआ या यूजर ID उपलब्ध नहीं।");
    }
    isOwnerOnline = !isOwnerOnline;
    await saveBotConfigToFirestore();
    res.redirect('/');
});

app.get('/toggle_personal_assistant', async (req, res) => {
    if (!db || !userId) {
        return res.status(500).send("Firebase इनिशियलाइज़ नहीं हुआ या यूजर ID उपलब्ध नहीं।");
    }
    isPersonalAssistantMode = !isPersonalAssistantMode;
    await saveBotConfigToFirestore();
    res.redirect('/');
});

app.get('/logout', async (req, res) => {
    if (client && isClientReady) {
        console.log('WhatsApp क्लाइंट लॉगआउट कर रहे हैं...');
        await client.logout();
        savedSession = null;
        qrCodeData = 'QR code is not generated yet. Please wait...';
        await saveBotConfigToFirestore();
        isClientReady = false;
        if (schedulerInterval) {
            clearInterval(schedulerInterval);
            console.log("शेड्यूलर बंद किया गया।");
        }
        res.redirect('/');
    } else {
        res.status(400).send('WhatsApp क्लाइंट तैयार नहीं है या पहले से लॉगआउट है।');
    }
});

// ✅ फिक्स्ड एंडपॉइंट
app.get('/api/scheduled-messages', async (req, res) => {
    if (!db || !userId) {
        return res.status(500).json({ error: "Firebase इनिशियलाइज़ नहीं हुआ या यूजर ID उपलब्ध नहीं।" });
    }
    try {
        const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
        const querySnapshot = await getDocs(scheduledMessagesRef);
        const messages = [];
        querySnapshot.forEach(doc => {
            const data = doc.data();
            if (data.createdAt instanceof Timestamp) {
                data.createdAt = data.createdAt.toDate().toISOString();
            }
            if (data.sentAt instanceof Timestamp) {
                data.sentAt = data.sentAt.toDate().toISOString();
            }
            messages.push({ id: doc.id, ...data });
        });
        messages.sort((a, b) => new Date(a.scheduledTime) - new Date(b.scheduledTime));
        res.json(messages);
    } catch (error) {
        console.error("शेड्यूल किए गए मैसेजेस को फेच करने में त्रुटि:", error);
        res.status(500).json({ error: "शेड्यूल किए गए मैसेजेस प्राप्त करने में त्रुटि।" });
    }
});

// Express ऐप को स्टार्ट करें
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});

// WhatsApp क्लाइंट इनिशियलाइज़ करें
initializeWhatsappClient();
