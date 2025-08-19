// app.js

// आवश्यक लाइब्रेरी आयात करें
// LocalAuth की जगह अब NoAuth का उपयोग किया जाएगा
const { Client } = require('whatsapp-web.js'); 
const qrcode = require('qrcode'); // QR कोड जेनरेट करने के लिए
const express = require('express'); // एक वेब सर्वर बनाने के लिए
// Firebase मॉड्यूल को Firestore संचालन के लिए अपडेट किया गया है
const { initializeApp } = require('firebase/app'); // Firebase ऐप इनिशियलाइज़ करने के लिए
const { getFirestore, doc, getDoc, setDoc, collection, addDoc, query, where, getDocs, updateDoc, Timestamp } = require('firebase/firestore'); // Firestore संचालन के लिए
const { getAuth, signInAnonymously, signInWithCustomToken } = require('firebase/auth'); // Firebase प्रमाणीकरण के लिए

// एक्सप्रेस ऐप और पोर्ट को सेट करें
const app = express();
const port = process.env.PORT || 3000; // Render पोर्ट को ऑटोमेटिकली सेट करता है

// JSON बॉडी को पार्स करने के यो लिए मिडलवेयर (फॉर्म डेटा के लिए)
app.use(express.urlencoded({ extended: true }));

// Firebase कॉन्फ़िग और ऐप ID को Render पर्यावरण चर से प्राप्त करें
const firebaseConfigRaw = process.env.FIREBASE_CONFIG; // Raw string को पढ़ें
let firebaseConfig = {};
try {
    if (firebaseConfigRaw) {
        firebaseConfig = JSON.parse(firebaseConfigRaw);
    }
} catch (e) {
    console.error("Error parsing FIREBASE_CONFIG environment variable:", e);
    console.log("Raw FIREBASE_CONFIG string:", firebaseConfigRaw); // Raw string को लॉग करें
}

console.log("Parsed firebaseConfig object:", firebaseConfig); // Parsed object को लॉग करें

const appId = process.env.__APP_ID || 'default-app-id'; // '__APP_ID' Render द्वारा प्रदान किया जाता है
const initialAuthToken = process.env.FIREBASE_AUTH_TOKEN || null; // '__INITIAL_AUTH_TOKEN' Render द्वारा प्रदान किया जाता है

let db;
let auth;
let userId; // Firebase यूजर ID
let isOwnerOnline = true; // डिफ़ॉल्ट रूप से ऑनलाइन (यह Firestore से ओवरराइड होगा)
let isPersonalAssistantMode = false; // डिफ़ॉल्ट रूप से पर्सनल असिस्टेंट मोड बंद
let qrCodeData = 'QR code is not generated yet. Please wait...'; // QR कोड डेटा (Base64)
let isClientReady = false;
let savedSession = null; // WhatsApp सेशन ऑब्जेक्ट को यहां स्टोर किया जाएगा (या JSON स्ट्रिंग)
let schedulerInterval; // शेड्यूल किए गए मैसेजेस को भेजने के लिए इंटरवल आईडी

// Firebase को इनिशियलाइज़ करें
if (Object.keys(firebaseConfig).length > 0) {
    try {
        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        auth = getAuth(firebaseApp);

        // Firebase प्रमाणित करें (अनाम या कस्टम टोकन के साथ)
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
                await loadBotConfigFromFirestore(); // प्रमाणीकरण के बाद कॉन्फ़िग और सेशन लोड करें
            } catch (error) {
                console.error("Firebase प्रमाणीकरण त्रुटि:", error);
                userId = crypto.randomUUID(); // यदि प्रमाणीकरण विफल रहता है तो एक रैंडम ID उपयोग करें
                console.warn("अनाधिकारिक यूजर ID का उपयोग कर रहे हैं (Firebase कॉन्फ़िग या टोकन समस्या हो सकती है):", userId);
            }
        };
        signInUser();
    } catch (error) {
        console.error("Firebase इनिशियलाइज़ करने में विफल:", error);
    }
} else {
    console.warn("Firebase कॉन्फ़िग नहीं मिली। स्थिति स्थायी नहीं होगी। कृपया Render में FIREBASE_CONFIG env var सेट करें।");
    userId = crypto.randomUUID(); // Firebase कॉन्फ़िग के बिना एक रैंडम ID उपयोग करें
}

// Firestore से बॉट कॉन्फ़िग और सेशन लोड करें
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
            // सेशन JSON स्ट्रिंग को ऑब्जेक्ट में पार्स करें
            savedSession = data.session ? JSON.parse(data.session) : null;
            console.log(`Firestore से बॉट कॉन्फ़िग लोड हुआ: मालिक ऑनलाइन=${isOwnerOnline}, पर्सनल असिस्टेंट मोड=${isPersonalAssistantMode}, सेशन मौजूद=${!!savedSession}`);
        } else {
            // यदि स्थिति मौजूद नहीं है, तो डिफ़ॉल्ट रूप से इनिशियलाइज़ करें
            isOwnerOnline = true;
            isPersonalAssistantMode = false;
            qrCodeData = 'QR code is not generated yet. Please wait...';
            savedSession = null; // कोई सेशन नहीं
            await setDoc(configDocRef, { isOwnerOnline: true, isPersonalAssistantMode: false, lastQrCodeData: qrCodeData, session: null });
            console.log("बॉट कॉन्फ़िग Firestore में इनिशियलाइज़ की गई: मालिक ऑनलाइन, पर्सनल असिस्टेंट मोड ऑफ, कोई सेशन नहीं।");
        }
    } catch (error) {
        console.error("Firestore से बॉट कॉन्फ़िग लोड करने में त्रुटि:", error);
    }
}

// Firestore में बॉट कॉन्फ़िग और सेशन सहेजें
async function saveBotConfigToFirestore() {
    if (!db || !userId) {
        console.warn("Firestore या User ID उपलब्ध नहीं, कॉन्फ़िग सहेजी नहीं जा सकती।");
        return;
    }
    const configDocRef = doc(db, `artifacts/${appId}/users/${userId}/whatsappBotConfig`, 'status');
    try {
        // सेशन ऑब्जेक्ट को JSON स्ट्रिंग के रूप में सहेजें
        // सुनिश्चित करें कि savedSession एक ऑब्जेक्ट है, अन्यथा null सेव करें
        const sessionToSave = (typeof savedSession === 'object' && savedSession !== null)
                               ? JSON.stringify(savedSession)
                               : null;
        console.log("Saving session to Firestore. Session exists:", !!savedSession); // <-- नया डीबग लॉग
        await setDoc(configDocRef, {
            isOwnerOnline,
            isPersonalAssistantMode,
            lastQrCodeData: qrCodeData,
            session: sessionToSave // यह अब हमेशा एक स्ट्रिंग या null होगा
        });
        console.log(`बॉट कॉन्फ़िग Firestore में सहेजी गई: मालिक ऑनलाइन=${isOwnerOnline}, पर्सनल असिस्टेंट मोड=${isPersonalAssistantMode}, सेशन सेव्ड=${!!sessionToSave}`);
    } catch (error) {
        console.error("Firestore में बॉट कॉन्फ़िग सहेजने में त्रुटि:", error);
    }
}

// एक सहायक फ़ंक्शन जो शेड्यूल कमांड को पार्स करता है
function parseScheduleCommand(messageBody, currentSenderId) {
    // उदाहरण: "send Hi to 9365374458 at 12:00am"
    // Regex को थोड़ा और मजबूत किया गया है ताकि समय में स्पेस के साथ 'am'/'pm' को भी हैंडल किया जा सके
    const regex = /^send\s+(.+)\s+to\s+([0-9+]+)\s+at\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)$/i;
    const match = messageBody.match(regex);

    if (!match) {
        return null; // कमांड फॉर्मेट से मेल नहीं खाता
    }

    let [, message, recipientRaw, timeString] = match;

    // Recipient number cleanup and WhatsApp ID format
    let recipient = recipientRaw.replace(/\D/g, ''); // केवल अंक रखें
    if (recipient.startsWith('0')) {
        recipient = recipient.substring(1); // यदि 0 से शुरू होता है तो उसे हटा दें
    }
    // भारतीय नंबर के लिए डिफ़ॉल्ट कंट्री कोड '91' जोड़ें यदि यह पहले से नहीं है
    if (recipient.length === 10 && !recipient.startsWith('91')) { // assuming 10 digit local numbers
        recipient = '91' + recipient;
    }
    recipient = `${recipient}@c.us`; // WhatsApp ID फॉर्मेट (व्यक्तिगत चैट के लिए)

    // Parse time
    const now = new Date();
    let scheduledDate = new Date(now); // वर्तमान तारीख के साथ शुरू करें

    // 'at' के बाद समय को पार्स करें
    let [hours, minutes] = [0, 0];
    const timeMatch = timeString.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (timeMatch) {
        hours = parseInt(timeMatch[1], 10);
        minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
        const ampm = timeMatch[3]?.toLowerCase();

        if (ampm === 'pm' && hours !== 12) {
            hours += 12;
        } else if (ampm === 'am' && hours === 12) { // 12 AM (midnight) is 00 hours
            hours = 0;
        }
    } else {
        // Fallback for simple military time or unrecognized format, try to parse directly
        const simpleTimeMatch = timeString.match(/(\d{1,2})(?::(\d{2}))?/);
        if (simpleTimeMatch) {
            hours = parseInt(simpleTimeMatch[1], 10);
            minutes = simpleTimeMatch[2] ? parseInt(simpleTimeMatch[2], 10) : 0;
        } else {
            console.warn("Could not parse time string:", timeString);
            return null; // Invalid time format
        }
    }

    scheduledDate.setHours(hours, minutes, 0, 0); // सेकंड और मिलीसेकंड को 0 पर सेट करें

    // यदि शेड्यूल किया गया समय वर्तमान समय से पहले है, तो उसे अगले दिन के लिए सेट करें
    // यह सुनिश्चित करता है कि मैसेज हमेशा भविष्य में शेड्यूल हो
    if (scheduledDate.getTime() <= now.getTime()) {
        scheduledDate.setDate(scheduledDate.getDate() + 1);
        console.log(`Scheduled time (${timeString}) is in the past today, scheduling for tomorrow.`);
    }

    console.log(`पार्स किया गया शेड्यूल: मैसेज="${message}", प्राप्तकर्ता="${recipient}", समय="${scheduledDate.toISOString()}"`);
    return {
        recipient: recipient,
        message: message,
        scheduledTime: scheduledDate.toISOString(), // ISO स्ट्रिंग के रूप में सेव करें
        requesterId: currentSenderId // जिसने मैसेज शेड्यूल किया
    };
}

// Firestore में शेड्यूल किए गए मैसेज को सेव करें
async function scheduleMessageInFirestore(scheduleDetails) {
    if (!db || !userId) {
        console.warn("Firestore या User ID उपलब्ध नहीं, शेड्यूल सेव नहीं हो सकता।");
        return false;
    }
    // शेड्यूल किए गए मैसेजेस के लिए एक नई कलेक्शन
    const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
    try {
        await addDoc(scheduledMessagesRef, {
            recipient: scheduleDetails.recipient,
            message: scheduleDetails.message,
            scheduledTime: scheduleDetails.scheduledTime, // ISO string
            status: 'pending', // शुरुआती स्थिति
            createdAt: Timestamp.now(), // निर्माण का समय
            requesterId: scheduleDetails.requesterId // मैसेज शेड्यूल करने वाले का ID
        });
        console.log("शेड्यूल किया गया मैसेज Firestore में सफलतापूर्वक सेव हुआ।");
        return true;
    } catch (error) {
        console.error("शेड्यूल किया गया मैसेज Firestore में सेव करने में त्रुटि:", error);
        return false;
    }
}

// शेड्यूल किए गए मैसेजेस को भेजने का फंक्शन
async function sendScheduledMessages() {
    // सुनिश्चित करें कि Firestore, यूजर ID और WhatsApp क्लाइंट तैयार हैं
    if (!db || !userId || !isClientReady) {
        console.log("शेड्यूलर: Firestore, User ID या WhatsApp क्लाइंट तैयार नहीं।");
        return;
    }

    console.log("शेड्यूलर: भेजने के लिए लंबित मैसेजेस की जाँच कर रहा है...");
    const now = new Date();
    const scheduledMessagesRef = collection(db, `artifacts/${appId}/users/${userId}/scheduledMessages`);
    // 'pending' स्थिति वाले सभी मैसेजेस को क्वेरी करें।
    // समय के आधार पर फ़िल्टरिंग मेमोरी में की जाएगी ताकि Firestore इंडेक्सिंग समस्याओं से बचा जा सके।
    const q = query(
        scheduledMessagesRef,
        where('status', '==', 'pending')
    );

    try {
        const querySnapshot = await getDocs(q);
        const messagesToSend = [];

        // क्वेरी परिणामों को फ़िल्टर करें जो अब भेजने के लिए तैयार हैं
        querySnapshot.forEach(docSnap => {
            const data = docSnap.data();
            // ISO स्ट्रिंग को तुलना के लिए Date ऑब्जेक्ट में बदलें
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
                // सुनिश्चित करें कि प्राप्तकर्ता फॉर्मेट client.sendMessage के लिए सही है
                let recipientToSend = msgData.recipient;
                if (!recipientToSend.endsWith('@c.us') && !recipientToSend.endsWith('@g.us')) {
                    // यदि किसी कारण से WhatsApp ID फॉर्मेट में नहीं है तो बुनियादी फॉलबैक
                    recipientToSend = `${recipientToSend}@c.us`;
                }

                await client.sendMessage(recipientToSend, msgData.message); // मैसेज भेजें
                // स्थिति को 'sent' में अपडेट करें
                await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/scheduledMessages`, msgData.id), {
                    status: 'sent',
                    sentAt: Timestamp.now()
                });
                console.log(`शेड्यूल किया गया मैसेज "${msgData.message}" को ${msgData.recipient} पर सफलतापूर्वक भेजा गया।`);

                // जिसने मैसेज शेड्यूल किया उसे सूचित करें यदि वह प्राप्तकर्ता नहीं है
                if (msgData.requesterId && msgData.requesterId !== recipientToSend && client.info?.wid?._serialized) {
                    await client.sendMessage(msgData.requesterId, `आपका शेड्यूल किया गया मैसेज "${msgData.message}" को ${msgData.recipient} पर सफलतापूर्वक भेज दिया गया है।`);
                }

            } catch (sendError) {
                console.error(`शेड्यूल किया गया मैसेज ${msgData.id} भेजने में त्रुटि:`, sendError);
                // त्रुटि होने पर स्थिति को 'failed' में अपडेट करें
                await updateDoc(doc(db, `artifacts/${appId}/users/${userId}/scheduledMessages`, msgData.id), {
                    status: 'failed',
                    error: sendError.message,
                    sentAt: Timestamp.now() // प्रयास का समय रिकॉर्ड करें
                });
                // संभवतः अनुरोधकर्ता को विफलता के बारे में सूचित करें
                if (msgData.requesterId && client.info?.wid?._serialized) {
                    await client.sendMessage(msgData.requesterId, `आपका शेड्यूल किया गया मैसेज "${msgData.message}" को ${msgData.recipient} पर भेजने में त्रुटि हुई: ${sendError.message}`);
                }
            }
        }
    } catch (error) {
        console.error("शेड्यूल किए गए मैसेजेस को प्रोसेस करने में त्रुटि:", error);
    }
}


let client; // क्लाइंट ऑब्जेक्ट को वैश्विक रूप से घोषित करें

// WhatsApp क्लाइंट को इनिशियलाइज़ करने का फंक्शन
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

    // यदि कोई सेव्ड सेशन है, तो उसे उपयोग करने का प्रयास करें
    // LocalAuth की जगह अब सीधे session ऑब्जेक्ट को पास करेंगे
    if (savedSession) {
        clientOptions.session = savedSession;
        console.log('सेव्ड सेशन के साथ क्लाइंट इनिशियलाइज़ करने का प्रयास कर रहे हैं...');
    } else {
        console.log('कोई सेव्ड सेशन नहीं मिला, QR कोड के लिए क्लाइंट इनिशियलाइज़ करेंगे...');
        // NoAuth की आवश्यकता नहीं है, यदि session ऑब्जेक्ट प्रदान नहीं किया जाता है तो लाइब्रेरी स्वचालित रूप से QR मोड में वापस आ जाती है
    }

    client = new Client(clientOptions);

    // ************* सभी client.on() लिसनर्स को यहां ले जाया गया *************
    client.on('qr', async qr => {
        console.log('QR कोड प्राप्त हुआ। इसे वेब पेज पर प्रदर्शित किया जाएगा और Firestore में सहेजा जाएगा।');
        qrCodeData = await qrcode.toDataURL(qr);
        await saveBotConfigToFirestore();
    });

    client.on('ready', async () => {
        isClientReady = true;
        console.log('WhatsApp क्लाइंट तैयार है! बॉट अब काम कर रहा है।');
        // client.info के पूरी तरह से पॉप्युलेट होने के लिए थोड़ा इंतजार करें (रेस कंडीशन से बचने के लिए)
        await new Promise(resolve => setTimeout(resolve, 1000)); // 1 सेकंड का विलंब

        const botOwnId = client.info?.wid?._serialized || null; // सुरक्षित एक्सेस के लिए ऑप्शनल चेनिंग
        if (botOwnId) {
            try {
                // मालिक को सूचित करें कि बॉट तैयार है
                await client.sendMessage(botOwnId, 'बॉट सफलतापूर्वक कनेक्ट हो गया है और अब आपके पर्सनल असिस्टेंट के रूप में कार्य करने के लिए तैयार है!');
                console.log(`कनेक्शन कन्फर्मेशन मैसेज ${botOwnId} को भेजा गया।`);
            } catch (error) {
                console.error('कनेक्शन कन्फर्मेशन मैसेज भेजने में त्रुटि:', error);
            }
        } else {
            console.warn('client.info.wid उपलब्ध नहीं है जब क्लाइंट तैयार है। कुछ WhatsApp ID-आधारित संचार विफल हो सकता है।');
        }

        // बॉट तैयार होने पर शेड्यूलर शुरू करें
        if (schedulerInterval) {
            clearInterval(schedulerInterval); // यदि पहले से चल रहा है तो साफ़ करें
        }
        // हर 1 मिनट (60 सेकंड) में शेड्यूल किए गए मैसेजेस की जाँच करें
        schedulerInterval = setInterval(sendScheduledMessages, 60 * 1000);
        console.log("शेड्यूल किए गए मैसेज भेजने के लिए शेड्यूलर शुरू किया गया।");
    });

    client.on('authenticated', async (session) => {
        console.log('WhatsApp क्लाइंट प्रमाणित हुआ और सेशन प्राप्त हुआ!');
        console.log("Raw session object from 'authenticated' event:", session); // <-- नया डीबग लॉग
        if (session && typeof session === 'object' && Object.keys(session).length > 0) {
            savedSession = session; // नए/मान्य सेशन ऑब्जेक्ट को स्टोर करें
            console.log("Debug: savedSession after authentication assigned:", savedSession ? "exists" : "null"); // <-- नया डीबग लॉग
        } else {
            savedSession = null;
            console.log("Debug: 'session' object from 'authenticated' event was empty or invalid.");
        }
        
        qrCodeData = 'WhatsApp क्लाइंट प्रमाणित है और ऑनलाइन है!'; // वेब पेज पर स्थिति अपडेट करें
        await saveBotConfigToFirestore(); // सेशन ऑब्जेक्ट और अपडेटेड QR मैसेज को Firestore में सहेजें
    });

    client.on('auth_failure', async (msg) => {
        console.error('प्रमाणीकरण विफल हुआ! सेशन साफ़ कर रहे हैं...', msg);
        qrCodeData = 'प्रमाणीकरण विफल हुआ। कृपया सेवा पुनरारंभ करें और QR कोड को फिर से स्कैन करें।';
        savedSession = null; // अमान्य सेशन को साफ़ करें
        await saveBotConfigToFirestore(); // Firestore अपडेट करें
        if (schedulerInterval) {
            clearInterval(schedulerInterval); // शेड्यूलर को बंद करें
            console.log("शेड्यूलर बंद किया गया।");
        }
    });

    client.on('disconnected', async (reason) => {
        console.log('WhatsApp डिस्कनेक्ट हो गया:', reason);
        savedSession = null; // सेशन को साफ़ करें
        qrCodeData = 'QR code is not generated yet. Please wait...'; // QR को रीसेट करें
        await saveBotConfigToFirestore();
        isClientReady = false;
        if (schedulerInterval) {
            clearInterval(schedulerInterval); // शेड्यूलर को बंद करें
            console.log("शेड्यूलर बंद किया गया।");
        }
    });

    // WhatsApp पर मैसेज आने पर
    client.on('message', async msg => {
        const messageBody = msg.body;
        const senderId = msg.from; // भेजने वाले का पूरा ID (उदाहरण: "91XXXXXXXXXX@c.us")
        const botOwnId = client.info?.wid?._serialized || null; // सुरक्षित एक्सेस के लिए ऑप्शनल चेनिंग

        console.log(`[मैसेज प्राप्त] ${senderId}: "${messageBody}"`);

        // 1. यदि मैसेज बॉट द्वारा भेजा गया है, तो उसे अनदेखा करें
        if (msg.fromMe) {
            return;
        }

        // 2. यदि मैसेज मालिक से आया है (बॉट का अपना नंबर)
        if (botOwnId && senderId === botOwnId) {
            const lowerCaseMessage = messageBody.toLowerCase().trim();

            // शेड्यूल मैसेज कमांड को हैंडल करें
            if (lowerCaseMessage.startsWith('send ')) {
                const scheduleDetails = parseScheduleCommand(messageBody, senderId);
                if (scheduleDetails) {
                    const success = await scheduleMessageInFirestore(scheduleDetails);
                    if (success) {
                        await client.sendMessage(senderId, `मैसेज "${scheduleDetails.message}" को ${scheduleDetails.recipient} पर ${new Date(scheduleDetails.scheduledTime).toLocaleString()} पर भेजने के लिए शेड्यूल किया गया है।`);
                    } else {
                        await client.sendMessage(senderId, 'शेड्यूल किया गया मैसेज सेव करने में त्रुटि हुई।');
                    }
                } else {
                    await client.sendMessage(senderId, 'क्षमा करें, आपके शेड्यूल कमांड का फॉर्मेट गलत है। कृपया "send [मैसेज] to [नंबर] at [समय]" का उपयोग करें। उदाहरण: "send Hi to 9365374458 at 12:00pm"');
                }
                return; // मालिक के शेड्यूल कमांड को हैंडल किया गया
            }

            // मालिक की स्थिति और पर्सनल असिस्टेंट मोड कमांड को हैंडल करें
            // इन कमांड्स पर हमेशा मालिक को जवाब दें
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
                    // मालिक को स्पष्ट रूप से बताएं कि बॉट अब अन्य यूज़र्स को जवाब नहीं देगा।
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

            // यदि मालिक का मैसेज है और पर्सनल असिस्टेंट मोड चालू है, तो Gemini API से जवाब दें
            if (isPersonalAssistantMode) {
                console.log('मालिक का मैसेज, पर्सनल असिस्टेंट मोड चालू है, बॉट जवाब देगा।');
                await handleBotResponse(msg);
                return;
            } else {
                // यदि मालिक का सामान्य मैसेज है और पर्सनल असिस्टेंट मोड बंद है, तो कोई जवाब न दें
                console.log('मालिक का मैसेज, पर्सनल असिस्टेंट मोड बंद है, बॉट जवाब नहीं देगा (केवल कमांड और शेड्यूल)।');
                return;
            }
        }

        // 3. यदि मैसेज मालिक से नहीं आया है (यानी किसी अन्य उपयोगकर्ता से है)
        // नई आवश्यकता के अनुसार, बॉट किसी अन्य उपयोगकर्ता को सीधे जवाब नहीं देगा।
        console.log(`मैसेज मालिक से नहीं आया है (${senderId}), बॉट सीधे जवाब नहीं देगा।`);
        return; // किसी अन्य उपयोगकर्ता से आए मैसेज को अनदेखा करें
    });

    client.initialize(); // क्लाइंट को यहां इनिशियलाइज़ करें
}

// बॉट प्रतिक्रिया उत्पन्न करने और भेजने के लिए एक सहायक फ़ंक्शन
async function handleBotResponse(msg) {
    const messageBody = msg.body;
    let botResponseText = '';
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY || ""; // Render env var से प्राप्त करें

    if (!GEMINI_API_KEY) {
        botResponseText = 'माफ़ करना, मैं अभी जवाब नहीं दे पा रहा हूँ। कृपया थोड़ी देर बाद फिर से कोशिश करें।';
    } else {
        try {
            // प्रॉम्प्ट को छोटे, दोस्ताना और सामान्य यूज़र जैसे जवाब के लिए अपडेट किया गया
            const prompt = `उपयोगकर्ता के इस संदेश का एक छोटा, दोस्ताना और सीधा जवाब दें, जैसे कोई आम इंसान देगा। कोई विकल्प या सूची न दें। संदेश: "${messageBody}"`;
            let chatHistoryForGemini = [];
            chatHistoryForGemini.push({ role: "user", parts: [{ text: prompt }] });

            const payload = { contents: chatHistoryForGemini };
            const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-05-20:generateContent?key=${GEMINI_API_KEY}`;

            let response;
            let result;
            let retries = 0;
            const maxRetries = 5;
            const baseDelay = 1000; // 1 second

            while (retries < maxRetries) {
                try {
                    response = await fetch(apiUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(payload)
                    });
                    result = await response.json();
                    if (result.candidates && result.candidates.length > 0 &&
                        result.candidates[0].content && result.candidates[0].content.parts &&
                        result.candidates[0].content.parts.length > 0) {
                        botResponseText = result.candidates[0].content.parts[0].text;
                        break;
                    } else {
                        console.warn("Gemini API ने अपेक्षित संरचना या सामग्री नहीं लौटाई।", result);
                        botResponseText = 'माफ़ करना, मैं अभी आपकी बात नहीं समझ पा रहा हूँ।'; // फॉलबैक
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
                        botResponseText = 'माफ़ करना, कुछ तकनीकी दिक्कत आ गई है।'; // रिट्री के बाद फॉलबैक
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


// वेब सर्वर सेटअप
app.get('/', async (req, res) => {
    // Firebase कॉन्फ़िग और यूजर ID उपलब्ध होने पर बॉट कॉन्फ़िग लोड करें
    if (db && userId) {
        await loadBotConfigFromFirestore();
    }

    // यदि क्लाइंट तैयार है तो बॉट की स्थिति और शेड्यूल फॉर्म वाला पेज दिखाएं
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
                    /* Custom styles for glowing buttons */
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
                    </div>

                    <div class="mt-8 pt-6 border-t border-gray-200">
                        <h2 class="text-2xl font-bold text-indigo-600 mb-4">शेड्यूल मैसेज</h2>
                        <form action="/schedule_message" method="POST" class="space-y-4">
                            <div>
                                <label for="recipientNumber" class="block text-left text-sm font-medium text-gray-700 mb-1">प्राप्तकर्ता नंबर (देश कोड के साथ, उदा: 919365374458):</label>
                                <input type="text" id="recipientNumber" name="recipientNumber" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" placeholder="उदा: 919365374458" required>
                            </div>
                            <div>
                                <label for="message" class="block text-left text-sm font-medium text-gray-700 mb-1">मैसेज:</label>
                                <textarea id="message" name="message" rows="3" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" placeholder="आपका मैसेज यहाँ लिखें" required></textarea>
                            </div>
                            <div>
                                <label for="scheduledTime" class="block text-left text-sm font-medium text-gray-700 mb-1">समय (आज या कल के लिए, HH:MM AM/PM):</label>
                                <input type="text" id="scheduledTime" name="scheduledTime" class="mt-1 block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 sm:text-sm" placeholder="उदा: 10:30 PM या 8:00 AM" required>
                            </div>
                            <button type="submit" class="w-full bg-green-500 hover:bg-green-600 text-white font-bold py-3 px-6 rounded-lg transition duration-300 ease-in-out transform hover:scale-105 shadow-md glow-button">
                                मैसेज शेड्यूल करें
                            </button>
                        </form>
                    </div>

                    <p class="text-xs text-gray-500 mt-4">यह आपकी स्थिति और सेशन को Firestore में सहेजेगा ताकि यह स्थायी रहे।</p>
                    <p class="text-xs text-gray-500 mt-2">नोट: बॉट अन्य यूज़र्स को जवाब नहीं देगा। यह केवल आपके निर्देशों का पालन करेगा और शेड्यूल किए गए मैसेजेस भेजेगा।</p>
                    <p class="text-xs text-gray-500 mt-2">आप खुद को 'Online true', 'Online false', 'Assistant on', 'Assistant off', या 'send [मैसेज] to [नंबर] at [समय]' मैसेज भेजकर भी स्थिति बदल सकते हैं।</p>
                </div>
            </body>
            </html>
        `);
    } else {
        // यदि क्लाइंट तैयार नहीं है तो QR कोड पेज दिखाएं
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
                    <p class="text-xs text-red-500 mt-2">ध्यान दें: यह बॉट whatsapp-web.js लाइब्रेरी का उपयोग करता है जो QR कोड का उपयोग करता है, पेयरिंग कोड का नहीं।</p>
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

// नया मार्ग जो शेड्यूल किए गए मैसेज फॉर्म को हैंडल करता है (POST अनुरोध)
app.post('/schedule_message', async (req, res) => {
    if (!db || !userId) {
        return res.status(500).send("Firebase इनिशियलाइज़ नहीं हुआ या यूजर ID उपलब्ध नहीं।");
    }

    // फॉर्म से प्राप्त डेटा
    const { recipientNumber, message, scheduledTime } = req.body;

    if (!recipientNumber || !message || !scheduledTime) {
        return res.status(400).send("कृपया सभी आवश्यक फ़ील्ड भरें।");
    }

    // `parseScheduleCommand` का उपयोग करके वेब फॉर्म से प्राप्त डेटा को प्रोसेस करें
    // यहां `currentSenderId` के लिए `client.info?.wid?._serialized` का उपयोग करें
    // यह दर्शाता है कि अनुरोध बॉट के स्वयं के उपयोगकर्ता द्वारा किया गया है
    const botOwnId = client.info?.wid?._serialized || userId; // अगर क्लाइंट तैयार नहीं है तो userId का उपयोग करें
    const scheduleDetails = parseScheduleCommand(
        `send ${message} to ${recipientNumber} at ${scheduledTime}`,
        botOwnId // requesterId के रूप में बॉट का अपना ID सेट करें
    );

    if (scheduleDetails) {
        const success = await scheduleMessageInFirestore(scheduleDetails);
        if (success) {
            res.redirect('/?scheduled=true'); // सफलता पर मुख्य पेज पर रीडायरेक्ट करें
        } else {
            res.status(500).send('शेड्यूल किया गया मैसेज सेव करने में त्रुटि हुई।');
        }
    } else {
        res.status(400).send('अवैध नंबर या समय फॉर्मेट। कृपया सुनिश्चित करें कि नंबर देश कोड के साथ है और समय HH:MM AM/PM फॉर्मेट में है।');
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
        // शेड्यूलर को बंद करें जब क्लाइंट लॉगआउट हो जाए
        if (schedulerInterval) {
            clearInterval(schedulerInterval);
            console.log("शेड्यूलर बंद किया गया।");
        }
        res.redirect('/');
    } else {
        res.status(400).send('WhatsApp क्लाइंट तैयार नहीं है या पहले से लॉगआउट है।');
    }
});


app.listen(port, async () => {
    console.log(`सर्वर http://localhost:${port} पर चल रहा है`);
    // Firebase और यूजर ID उपलब्ध होने पर बॉट कॉन्फ़िग लोड करें और WhatsApp क्लाइंट शुरू करें
    if (db && userId) {
        await loadBotConfigFromFirestore();
        initializeWhatsappClient();
    } else {
        console.error("Firebase कॉन्फ़िग या USER ID उपलब्ध नहीं। WhatsApp क्लाइंट बिना परसिस्टेंस के शुरू होगा।");
        initializeWhatsappClient();
    }
});
