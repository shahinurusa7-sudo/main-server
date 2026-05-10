require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const nodemailer = require('nodemailer');
const PendingMessage = require('./models/PendingMessage');
const User = require('./models/User');
const Like = require('./models/Like');
const Match = require('./models/Match');
const ProfileView = require('./models/ProfileView');
const Status = require('./models/Status');
const Ad = require('./models/Ad');
const Analytics = require('./models/Analytics');
const packageJson = require('./package.json');
const push = require('./push notification');

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3002;

// Middleware
// Disable helmet's crossOriginResourcePolicy so Socket.IO polling works.
// Default 'same-origin' policy blocks Flutter/mobile clients from reading
// the /socket.io/... polling responses.
app.use(helmet({
  crossOriginResourcePolicy: false,
  crossOriginOpenerPolicy: false,
}));
app.use(cors({
  origin: (origin, callback) => {
    // Allow all origins if ALLOWED_ORIGINS is '*'
    if (!origin || process.env.ALLOWED_ORIGINS === '*') {
      callback(null, true);
    } else {
      const allowed = process.env.ALLOWED_ORIGINS.split(',');
      if (allowed.indexOf(origin) !== -1) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(morgan('combined')); // Logging

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: 'Too many requests from this IP, please try again later.'
});
app.use('/api/', limiter);

// Initialize Firebase Admin SDK
let serviceAccount;
try {
  const configuredFileName =
    process.env.FIREBASE_SERVICE_ACCOUNT_FILE ||
    packageJson.config?.firebaseServiceAccountFile ||
    'serviceAccountKey.json';

  const serviceAccountPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH
    ? path.resolve(__dirname, process.env.FIREBASE_SERVICE_ACCOUNT_PATH)
    : path.resolve(__dirname, configuredFileName);

  const useJsonEnv =
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON &&
    process.env.FIREBASE_SERVICE_ACCOUNT_SOURCE === 'env';

  // Prefer file-based credentials by default to avoid accidental stale env vars.
  if (!useJsonEnv && fs.existsSync(serviceAccountPath)) {
    serviceAccount = require(serviceAccountPath);
    console.log(`🔐 Firebase credentials source: file (${serviceAccountPath})`);
    // Crucially fix "16 UNAUTHENTICATED Request had invalid authentication credentials" FCM error
    process.env.GOOGLE_APPLICATION_CREDENTIALS = serviceAccountPath;
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    console.log('🔐 Firebase credentials source: FIREBASE_SERVICE_ACCOUNT_JSON');
  } else {
    throw new Error(
      `Firebase service account not found. Checked file: ${serviceAccountPath}`
    );
  }

  // Normalize escaped newlines in private key if loaded from env JSON.
  if (typeof serviceAccount.private_key === 'string') {
    serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    throw new Error('Invalid Firebase service account JSON content');
  }

  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET
  });

  console.log('✅ Firebase Admin SDK initialized successfully');
  // Initialize push notification module (MongoDB-only, no Firestore)
  push.init(admin, require('./models/User'));
} catch (error) {
  console.error('❌ Error initializing Firebase Admin SDK:', error.message);
  process.exit(1);
}

// Firebase services
const db = admin.firestore();
const realtimeDb = admin.database();
const auth = admin.auth();
const storage = admin.storage();

const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587', 10);
const SMTP_SECURE = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_EMAIL = process.env.SMTP_FROM_EMAIL || SMTP_USER;
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Julieet Team';
const SMTP_REPLY_TO = process.env.SMTP_REPLY_TO || SMTP_FROM_EMAIL;
const COMPANY_NAME = process.env.COMPANY_NAME || 'Julieet';
const CEO_NAME = process.env.CEO_NAME || 'Shahinur Alam';
const CEO_TITLE = process.env.CEO_TITLE || 'Chief Executive Officer';
const APP_LOGIN_URL = process.env.APP_LOGIN_URL || 'https://julieet.com';
const WELCOME_EMAIL_ENABLED =
  String(process.env.WELCOME_EMAIL_ENABLED || 'true').toLowerCase() === 'true';

const smtpConfigured =
  SMTP_HOST.length > 0 &&
  Number.isFinite(SMTP_PORT) &&
  SMTP_PORT > 0 &&
  SMTP_USER.length > 0 &&
  SMTP_PASS.length > 0 &&
  SMTP_FROM_EMAIL.length > 0;

const smtpTransporter = smtpConfigured
  ? nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  })
  : null;

app.set('smtpTransporter', smtpTransporter);


if (WELCOME_EMAIL_ENABLED) {
  if (smtpConfigured) {
    console.log(`📧 SMTP welcome email enabled (${SMTP_HOST}:${SMTP_PORT})`);
  } else {
    console.warn('⚠️ WELCOME_EMAIL_ENABLED=true but SMTP is not fully configured. Welcome emails will be skipped.');
  }
}

const escapeHtml = (value) => String(value || '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const getDisplayNameFromUserData = (data, fallbackEmail = '') => {
  const candidates = [
    data?.displayName,
    data?.name,
    data?.username,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  if (typeof fallbackEmail === 'string' && fallbackEmail.includes('@')) {
    return fallbackEmail.split('@')[0];
  }

  return 'there';
};

const getWelcomeRecipientName = async ({ userId, email, firestoreData }) => {
  const candidateNames = [];

  try {
    const userRecord = await auth.getUser(userId);
    candidateNames.push(userRecord.displayName);
    candidateNames.push(userRecord.email);
  } catch (error) {
    console.warn(`⚠️ Could not read Firebase Auth user ${userId}: ${error.message}`);
  }

  candidateNames.push(
    firestoreData?.displayName,
    firestoreData?.name,
    firestoreData?.username,
  );

  for (const candidate of candidateNames) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  if (typeof email === 'string' && email.includes('@')) {
    return email.split('@')[0];
  }

  return 'there';
};

const buildWelcomeEmail = ({ userName }) => {
  const safeName = escapeHtml(userName || 'there');
  const safeCompany = escapeHtml(COMPANY_NAME);
  const safeCeoName = escapeHtml(CEO_NAME);
  const safeCeoTitle = escapeHtml(CEO_TITLE);
  const safeLoginUrl = escapeHtml(APP_LOGIN_URL);

  const subject = `Welcome to ${COMPANY_NAME}, ${userName || 'friend'}!`;

  const html = `
  <div style="background:#f3f6fb;padding:28px 12px;font-family:Segoe UI,Arial,sans-serif;color:#1e293b;">
    <div style="max-width:640px;margin:0 auto;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #dbe3ef;">
      <div style="padding:28px 30px;background:linear-gradient(120deg,#E92163,#FF6B9D);color:#ffffff;">
        <h1 style="margin:0;font-size:24px;line-height:1.2;">Welcome to ${safeCompany} 💕</h1>
        <p style="margin:10px 0 0 0;font-size:14px;opacity:.92;">We are delighted to have you with us.</p>
      </div>
      <div style="padding:28px 30px;">
        <p style="margin:0 0 14px 0;font-size:16px;">Dear ${safeName},</p>
        <p style="margin:0 0 14px 0;font-size:15px;line-height:1.7;">
          Thank you for joining ${safeCompany}. Your account is now active and ready.
          We built this platform to help you connect meaningfully, safely, and confidently.
        </p>
        <p style="margin:0 0 18px 0;font-size:15px;line-height:1.7;">
          If you need any assistance, our team is here to support you.
        </p>
        <a href="${safeLoginUrl}" style="display:inline-block;background:#E92163;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;font-size:14px;">Open ${safeCompany}</a>
        <div style="margin-top:24px;padding-top:18px;border-top:1px solid #e2e8f0;">
          <p style="margin:0 0 6px 0;font-size:15px;">Warm regards,</p>
          <p style="margin:0;font-size:15px;font-weight:700;">${safeCeoName}</p>
          <p style="margin:4px 0 0 0;font-size:13px;color:#475569;">${safeCeoTitle}</p>
          <p style="margin:12px 0 0 0;font-size:13px;color:#475569;">${safeCompany}</p>
        </div>
      </div>
    </div>
  </div>`;

  const text = [
    `Welcome to ${COMPANY_NAME}`,
    '',
    `Dear ${userName || 'there'},`,
    '',
    `Thank you for joining ${COMPANY_NAME}. Your account is now active and ready.`,
    `Open the app here: ${APP_LOGIN_URL}`,
    '',
    'Warm regards,',
    `${CEO_NAME}`,
    `${CEO_TITLE}`,
    `${COMPANY_NAME}`,
  ].join('\n');

  return { subject, html, text };
};

const sendWelcomeEmail = async ({ email, userName }) => {
  if (!WELCOME_EMAIL_ENABLED) {
    return { sent: false, reason: 'welcome_disabled' };
  }

  if (!smtpTransporter || !smtpConfigured) {
    return { sent: false, reason: 'smtp_not_configured' };
  }

  const target = String(email || '').trim();
  if (!target) {
    return { sent: false, reason: 'missing_email' };
  }

  const content = buildWelcomeEmail({ userName });
  await smtpTransporter.sendMail({
    from: `"${SMTP_FROM_NAME}" <${SMTP_FROM_EMAIL}>`,
    to: target,
    replyTo: SMTP_REPLY_TO,
    subject: content.subject,
    text: content.text,
    html: content.html,
  });

  return { sent: true };
};

const maybeSendWelcomeEmailForUser = async ({ userId, fallbackEmail = '' }) => {
  if (!WELCOME_EMAIL_ENABLED) {
    return { status: 'disabled' };
  }

  let candidate = null;
  let firestoreData = null;

  const userDoc = await User.findOneAndUpdate(
    {
      uid: userId,
      welcomeEmailSentAt: null,
      welcomeEmailLockAt: null,
    },
    {
      $set: {
        welcomeEmailLockAt: new Date(),
      },
    },
    {
      new: true,
    }
  ).lean();

  if (!userDoc) {
    return { status: 'skipped' };
  }

  firestoreData = userDoc;

  const email = String(userDoc.email || fallbackEmail || '').trim();
  if (!email) {
    await User.updateOne(
      { uid: userId },
      {
        $unset: { welcomeEmailLockAt: 1 },
      }
    );
    return { status: 'skipped' };
  }

  candidate = {
    email,
    userName: getDisplayNameFromUserData(userDoc, email),
  };

  await User.updateOne(
    { uid: userId },
    {
      $set: {
        welcomeEmailRecipient: email,
      },
    }
  );

  if (!candidate) {
    return { status: 'skipped' };
  }

  try {
    const userName = await getWelcomeRecipientName({
      userId,
      email: candidate.email,
      firestoreData,
    });

    const result = await sendWelcomeEmail({
      email: candidate.email,
      userName,
    });
    if (result.sent) {
      await User.updateOne(
        { uid: userId },
        {
          $set: { welcomeEmailSentAt: new Date() },
          $unset: { welcomeEmailError: 1, welcomeEmailLockAt: 1 },
        }
      );
      return { status: 'sent' };
    }

    await User.updateOne(
      { uid: userId },
      {
        $set: { welcomeEmailError: result.reason || 'unknown' },
        $unset: { welcomeEmailLockAt: 1 },
      }
    );
    return { status: 'failed', reason: result.reason || 'unknown' };
  } catch (error) {
    await User.updateOne(
      { uid: userId },
      {
        $set: { welcomeEmailError: error.message },
        $unset: { welcomeEmailLockAt: 1 },
      }
    );

    return { status: 'failed', reason: error.message };
  }
};

const safeDecodeURIComponent = (value) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const maskMongoUri = (uri) => uri.replace(/(mongodb(?:\+srv)?:\/\/[^:]+:)([^@]+)(@.*)/, '$1***$3');

const MESSAGE_ENCRYPTION_ALGO = 'aes-256-gcm';
const MESSAGE_ENCRYPTION_VERSION = 'v1';

const getMessageEncryptionKey = () => {
  const rawKey =
    process.env.OFFLINE_MSG_ENCRYPTION_KEY ||
    process.env.MESSAGE_ENCRYPTION_KEY ||
    process.env.JWT_SECRET;

  if (!rawKey) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'Missing encryption key. Set OFFLINE_MSG_ENCRYPTION_KEY (or MESSAGE_ENCRYPTION_KEY/JWT_SECRET).'
      );
    }

    console.warn(
      '⚠️  Using development fallback message encryption key. Set OFFLINE_MSG_ENCRYPTION_KEY for secure environments.'
    );
    return crypto.createHash('sha256').update('julieet-dev-offline-message-key').digest();
  }

  return crypto.createHash('sha256').update(String(rawKey)).digest();
};

const encryptMessageContent = (plainText) => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(MESSAGE_ENCRYPTION_ALGO, getMessageEncryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(String(plainText || ''), 'utf8'),
    cipher.final(),
  ]);

  return {
    content: encrypted.toString('base64'),
    enc: {
      v: MESSAGE_ENCRYPTION_VERSION,
      alg: MESSAGE_ENCRYPTION_ALGO,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    }
  };
};

const decryptMessageContent = (encryptedContent, metadata) => {
  const enc = metadata?.enc;

  if (
    !enc ||
    enc.alg !== MESSAGE_ENCRYPTION_ALGO ||
    !enc.iv ||
    !enc.tag ||
    !encryptedContent
  ) {
    return encryptedContent || '';
  }

  try {
    const decipher = crypto.createDecipheriv(
      MESSAGE_ENCRYPTION_ALGO,
      getMessageEncryptionKey(),
      Buffer.from(enc.iv, 'base64')
    );
    decipher.setAuthTag(Buffer.from(enc.tag, 'base64'));

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedContent, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf8');
  } catch (error) {
    console.warn('Warning: failed to decrypt pending message content:', error.message);
    return '';
  }
};

const serializePendingMessageForClient = (msg) => ({
  messageId: msg.messageId,
  senderId: msg.senderId,
  receiverId: msg.receiverId,
  chatId: msg.chatId,
  messageType: msg.messageType,
  content: decryptMessageContent(msg.content, msg.metadata),
  mediaUrl: msg.mediaUrl,
  thumbnailUrl: msg.thumbnailUrl,
  createdAt: msg.createdAt,
  metadata: msg.metadata || {}
});

/**
 * Collect all valid FCM tokens for a user from both 'fcmToken' (single)
 * and 'fcmTokens' (map of token -> true/false) fields.
 */
const collectFcmTokensForUser = async (userId) => {
  const userData = await User.findOne({ uid: userId }).select('fcmToken fcmTokens').lean();
  if (!userData) return [];

  const tokens = new Set();

  // Single token field
  if (typeof userData.fcmToken === 'string' && userData.fcmToken.trim().length > 0) {
    tokens.add(userData.fcmToken.trim());
  }

  // Map of { token: true/false }
  if (userData.fcmTokens && typeof userData.fcmTokens === 'object') {
    for (const [token, enabled] of Object.entries(userData.fcmTokens)) {
      if (typeof token === 'string' && token.trim().length > 0 && enabled === true) {
        tokens.add(token.trim());
      }
    }
  }

  return Array.from(tokens);
};

/**
 * Send a push notification to a user by their userId.
 * Looks up all their FCM tokens and sends to each (up to 3).
 * Returns true if at least one notification was sent.
 */
const sendPushToUser = async (userId, { title, body, data = {} }) => {
  if (!userId) return false;
  try {
    const tokens = await collectFcmTokensForUser(userId);
    if (tokens.length === 0) {
      console.warn(`⚠️ [FCM] No FCM tokens found for user ${userId}`);
      return false;
    }

    // Ensure all data values are strings (FCM requirement)
    const stringData = {};
    for (const [k, v] of Object.entries(data)) {
      stringData[k] = String(v ?? '');
    }

    let sent = 0;
    for (const token of tokens.slice(0, 3)) {
      try {
        // Determine channel based on notification type
        const type = stringData.type || '';
        const channelId = (type === 'like' || type === 'match') ? 'matches' : 'messages';

        await admin.messaging().send({
          notification: { title, body },
          data: stringData,
          token,
          // Android: high priority so the notification is delivered instantly
          // even when the device is in Doze mode or the app is closed
          android: {
            priority: 'high',
            notification: {
              channelId,
              priority: 'high',
              defaultSound: true,
              defaultVibrateTimings: true,
              notificationCount: 1,
            },
          },
          // iOS: max priority so APNs delivers it immediately
          apns: {
            headers: {
              'apns-priority': '10',
              'apns-push-type': 'alert',
            },
            payload: {
              aps: {
                sound: 'default',
                badge: 1,
                contentAvailable: true,
              },
            },
          },
        });
        sent++;
      } catch (tokenErr) {
        // Remove stale token from MongoDB if FCM explicitly rejects it
        if (tokenErr.code === 'messaging/registration-token-not-registered' ||
          tokenErr.code === 'messaging/invalid-registration-token') {
          console.warn(`🗑️ [FCM] Removing stale token for user ${userId}`);
          User.updateOne({ uid: userId }, { $unset: { fcmToken: '' } }).catch(() => { });
        }
        console.warn(`⚠️ [FCM] Failed to send to token for ${userId}: ${tokenErr.message}`);
      }
    }

    console.log(`✅ [FCM] Sent ${sent}/${tokens.length} notifications to user ${userId}`);
    return sent > 0;
  } catch (error) {
    console.warn(`⚠️ [FCM] sendPushToUser error for ${userId}: ${error.message}`);
    return false;
  }
};

const sendNewMessagePushNotification = async ({
  receiverId,
  senderId,
  chatId,
  messageId,
  messageType,
  content,
}) => {
  if (!receiverId) return false;

  // Attempt to get sender name for a better notification
  let senderName = 'New Message';
  try {
    const sender = await User.findOne({ uid: senderId }).select('displayName').lean();
    if (sender && sender.displayName) {
      senderName = sender.displayName;
    }
  } catch (e) {
    console.warn(`⚠️ [FCM] Could not fetch sender name for ${senderId}: ${e.message}`);
  }

  return sendPushToUser(receiverId, {
    title: senderName,
    body: messageType === 'text' ? String(content || '').slice(0, 100) : `Sent a ${messageType || 'message'}`,
    data: {
      type: 'new_message',
      chatId: String(chatId || ''),
      messageId: String(messageId || ''),
      senderId: String(senderId || ''),
      senderName: senderName,
    },
  });
};

const normalizeMongoUri = (uri) => {
  if (!uri) {
    return uri;
  }

  const trimmedUri = uri.trim().replace(/^['"]|['"]$/g, '');
  if (!trimmedUri.startsWith('mongodb://') && !trimmedUri.startsWith('mongodb+srv://')) {
    return trimmedUri;
  }

  const protocolSeparatorIndex = trimmedUri.indexOf('://');
  const lastAtIndex = trimmedUri.lastIndexOf('@');

  if (protocolSeparatorIndex === -1 || lastAtIndex === -1) {
    return trimmedUri;
  }

  const credentialsAndHost = trimmedUri.slice(protocolSeparatorIndex + 3);
  const credentialsPart = credentialsAndHost.slice(0, credentialsAndHost.lastIndexOf('@'));
  const hostAndQuery = credentialsAndHost.slice(credentialsAndHost.lastIndexOf('@') + 1);
  const firstColonIndex = credentialsPart.indexOf(':');

  if (firstColonIndex === -1) {
    return trimmedUri;
  }

  const username = credentialsPart.slice(0, firstColonIndex);
  const rawPassword = credentialsPart.slice(firstColonIndex + 1);
  const encodedPassword = encodeURIComponent(safeDecodeURIComponent(rawPassword));
  const prefix = trimmedUri.slice(0, protocolSeparatorIndex + 3);

  return `${prefix}${username}:${encodedPassword}@${hostAndQuery}`;
};

// Initialize MongoDB connection with retry logic
const connectMongoDB = async (attempt = 1, maxAttempts = 3) => {
  try {
    const configuredMongoUri = process.env.MONGODB_URI || 'mongodb+srv://doadmin:8R67T5uh2V9M13dj@dbaas-db-8716287-669712ac.mongo.ondigitalocean.com/admin?tls=true&authSource=admin&replicaSet=dbaas-db-8716287';
    const mongoUri = normalizeMongoUri(configuredMongoUri);

    console.log(`🔄 MongoDB connection attempt ${attempt}/${maxAttempts}...`);

    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 30000, // Increased from 15s to 30s
      socketTimeoutMS: 45000,
      family: 4, // Use IPv4 if available
      retryWrites: true,
      maxPoolSize: 10,
      minPoolSize: 2,
    });

    console.log('✅ MongoDB connected successfully');
    console.log(`📦 Temporary SMS/message storage active in MongoDB: ${maskMongoUri(mongoUri)}`);

    // Setup automatic cleanup of old delivered messages (runs daily)
    setInterval(async () => {
      try {
        const result = await PendingMessage.cleanupOldMessages(7);
        console.log(`🧹 Cleaned up ${result.deletedCount} old messages`);
      } catch (error) {
        console.error('Error cleaning up old messages:', error);
      }
    }, 24 * 60 * 60 * 1000); // Run every 24 hours

  } catch (error) {
    console.error(`❌ MongoDB connection attempt ${attempt} failed:`, error.message);

    // Log more diagnostic info
    if (error.reason) console.error('   Reason:', error.reason);
    if (error.code) console.error('   Code:', error.code);

    if (attempt < maxAttempts) {
      const delayMs = Math.min(5000 * attempt, 15000); // Exponential backoff: 5s, 10s, 15s
      console.log(`⏳ Retrying in ${delayMs / 1000} seconds...`);
      setTimeout(() => connectMongoDB(attempt + 1, maxAttempts), delayMs);
    } else {
      console.warn('⚠️  Could not establish MongoDB connection after several attempts.');
      console.warn('💡 Troubleshooting tips:');
      console.warn('   1. Verify the MongoDB URI in .env is correct');
      console.warn('   2. Check that your server IP is whitelisted in MongoDB Atlas/DigitalOcean');
      console.warn('   3. Ensure network connectivity to the MongoDB cluster');
      console.warn('   4. Check MongoDB cluster status at your provider dashboard');
      console.warn('⚠️  Server running without MongoDB. Message queue features disabled.');
    }
  }
};

connectMongoDB();

const toPlainObject = (value) => {
  if (!value) {
    return null;
  }
  if (typeof value.toObject === 'function') {
    return value.toObject();
  }
  return value;
};

const sanitizeMongoDoc = (value) => {
  const plain = toPlainObject(value);
  if (!plain) {
    return null;
  }

  const { _id, __v, ...rest } = plain;
  return rest;
};

const parseLimit = (value, fallback = 50, max = 200) => {
  const parsed = parseInt(String(value || fallback), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
};

const getMatchId = (user1Id, user2Id) => {
  const sortedIds = [String(user1Id), String(user2Id)].sort();
  return `${sortedIds[0]}_${sortedIds[1]}`;
};

const buildDefaultUserData = ({
  uid,
  email = '',
  displayName = 'User',
  photoURL = '',
  isProfileComplete = false,
} = {}) => ({
  uid,
  email,
  displayName,
  photoURL,
  photos: [],
  phone: '',
  phoneVerified: false,
  authProvider: 'google',
  gender: '',
  dob: '',
  age: 18,
  bio: '',
  location: {
    country: '',
    state: '',
    city: '',
    coordinates: null,
  },
  interests: [],
  languages: [],
  lifestyle: {},
  height: '',
  hairColor: '',
  eyeColor: '',
  education: '',
  job: '',
  verified: false,
  likedUsers: [],
  likedBy: [],
  matches: [],
  contactInfo: {},
  photoCaptions: {},
  online: false,
  lastSeen: null,
  lastActive: new Date(),
  profileViews: 0,
  isProfileComplete,
});

const hasText = (value) => typeof value === 'string' && value.trim().length > 0;

const asStringList = (value) => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => String(item || '').trim())
    .filter((item) => item.length > 0);
};

const isProfileDataComplete = (data = {}) => {
  const displayName = String(data.displayName || '').trim();
  const gender = String(data.gender || '').trim();
  const bio = String(data.bio || '').trim();
  const photoURL = String(data.photoURL || '').trim();
  const photos = asStringList(data.photos);
  const interests = asStringList(data.interests);
  const languages = asStringList(data.languages);
  const location = data.location && typeof data.location === 'object' ? data.location : {};
  const country = String(location.country || '').trim();
  const city = String(location.city || '').trim();
  const dob = data.dob;
  const hasDob =
    dob instanceof Date ||
    (typeof dob === 'string' && dob.trim().length > 0) ||
    (typeof dob === 'number' && Number.isFinite(dob));

  return (
    displayName.length > 0 &&
    gender.length > 0 &&
    hasDob &&
    country.length > 0 &&
    city.length > 0 &&
    languages.length > 0 &&
    interests.length >= 5 &&
    bio.length > 0 &&
    photoURL.length > 0 &&
    photos.length >= 2
  );
};

const normalizeUserWritePayload = (payload = {}) => {
  const fields = { ...payload };
  delete fields._id;
  delete fields.__v;
  delete fields.id;
  delete fields.createdAt;
  delete fields.updatedAt;

  if (fields.location && typeof fields.location !== 'object') {
    delete fields.location;
  }

  // Convert empty emails to null to respect sparse unique index
  if ('email' in fields && (!fields.email || fields.email.trim() === '')) {
    fields.email = null;
  }

  if (Array.isArray(fields.photos)) {
    fields.photos = asStringList(fields.photos);
  }
  if (Array.isArray(fields.interests)) {
    fields.interests = asStringList(fields.interests);
  }
  if (Array.isArray(fields.languages)) {
    fields.languages = asStringList(fields.languages);
  }
  if (Array.isArray(fields.likedUsers)) {
    fields.likedUsers = asStringList(fields.likedUsers);
  }
  if (Array.isArray(fields.likedBy)) {
    fields.likedBy = asStringList(fields.likedBy);
  }
  if (Array.isArray(fields.matches)) {
    fields.matches = asStringList(fields.matches);
  }

  fields.lastActive = new Date();

  return fields;
};

const serializeUser = (userDoc) => {
  const data = sanitizeMongoDoc(userDoc);
  if (!data) {
    return null;
  }

  return {
    ...data,
    uid: data.uid,
  };
};

const ensureMongoUserRecord = async ({
  uid,
  email = null,
  displayName = 'User',
  photoURL = '',
  isProfileComplete = false,
  extra = {},
} = {}) => {
  const updateFields = normalizeUserWritePayload({
    email,
    displayName,
    photoURL,
    ...extra,
    isProfileComplete,
  });

  // Build default data only for fields on insert (avoid conflicts with $set)
  const defaultData = buildDefaultUserData({
    uid,
    email,
    displayName,
    photoURL,
    isProfileComplete,
  });

  // Remove from $setOnInsert any fields that are in $set to avoid conflicts
  const setOnInsertData = {};
  for (const key in defaultData) {
    if (!(key in updateFields)) {
      setOnInsertData[key] = defaultData[key];
    }
  }

  return User.findOneAndUpdate(
    { uid },
    {
      $setOnInsert: setOnInsertData,
      $set: updateFields,
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );
};

const ensureActiveMatch = async (user1Id, user2Id) => {
  const matchId = getMatchId(user1Id, user2Id);
  const participants = [user1Id, user2Id].sort();

  await Match.findOneAndUpdate(
    { matchId },
    {
      $set: {
        user1Id: participants[0],
        user2Id: participants[1],
        participants,
        status: 'active',
        deletedAt: null,
        timestamp: new Date(),
      },
    },
    {
      upsert: true,
      new: true,
      setDefaultsOnInsert: true,
    }
  );

  await Promise.all([
    User.updateOne(
      { uid: user1Id },
      {
        $addToSet: { matches: user2Id },
      }
    ),
    User.updateOne(
      { uid: user2Id },
      {
        $addToSet: { matches: user1Id },
      }
    ),
  ]);

  return matchId;
};

const getPresencePayload = async (userId) => {
  const userDoc = await User.findOne({ uid: userId }).lean();
  const isOnline = isUserOnline(userId) || userDoc?.online === true;
  const lastSeen =
    userDoc?.lastSeen instanceof Date
      ? userDoc.lastSeen.toISOString()
      : userDoc?.lastSeen || null;

  return {
    userId,
    status: isOnline ? 'online' : 'offline',
    lastSeen,
  };
};

// Middleware to verify Firebase token
const verifyToken = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];

    if (!token) {
      console.log('❌ No authorization token provided');
      return res.status(401).json({ error: 'No token provided', message: 'Authorization header missing' });
    }

    console.log('🔐 Verifying Firebase ID token...');
    const decodedToken = await auth.verifyIdToken(token);
    console.log(`✅ Token verified for user: ${decodedToken.uid} (${decodedToken.email})`);

    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('❌ Token verification failed:', error.message);
    console.error('   Error code:', error.code);
    return res.status(403).json({
      error: 'Invalid or expired token',
      message: `Token verification failed: ${error.message}`,
      code: error.code
    });
  }
};

// ==================== ROUTES ====================

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: 'Love Birds Server API',
    version: '1.0.0',
    timestamp: new Date().toISOString()
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// ==================== FIRESTORE DIAGNOSTICS ====================

/**
 * Test Firestore connection and permissions
 * No auth required - helps diagnose connection issues
 */
app.get('/api/firestore-test', async (req, res) => {
  try {
    console.log('\n🧪 ===== FIRESTORE DIAGNOSTICS TEST =====');

    // Test 1: Check if db is initialized
    console.log('✓ Step 1: Check Firestore initialization');
    if (!db) {
      return res.status(500).json({
        success: false,
        message: 'Firestore not initialized',
        steps: {
          step1: { status: 'FAILED', message: 'db object is null' }
        }
      });
    }
    console.log('  ✅ Firestore initialized');

    // Test 2: Try a simple query
    console.log('✓ Step 2: Attempt a test collection query');
    const testCollection = await db.collection('_firestore_config').limit(1).get();
    console.log(`  ✅ Query succeeded. Collection exists: ${!testCollection.empty}`);

    // Test 3: Check project ID
    console.log('✓ Step 3: Verify project configuration');
    const projectId = serviceAccount.project_id;
    console.log(`  ✅ Project ID from serviceAccount: ${projectId}`);

    // Test 4: Try to read from 'users' collection
    console.log('✓ Step 4: Test users collection access');
    const usersSnap = await db.collection('users').limit(1).get();
    console.log(`  ✅ Users collection accessible. Exists: ${!usersSnap.empty}`);
    if (!usersSnap.empty) {
      console.log(`  📄 Sample document found: ${usersSnap.docs[0].id}`);
    }

    res.json({
      success: true,
      message: 'Firestore is working correctly',
      diagnostics: {
        firestoreInitialized: true,
        projectId: projectId,
        collectionsAccessible: {
          '_firestore_config': !testCollection.empty,
          'users': !usersSnap.empty
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('❌ Firestore test failed:', error.message);
    console.error('   Error code:', error.code);
    console.error('   Full error:', error);

    res.status(500).json({
      success: false,
      message: 'Firestore diagnostic test failed',
      error: {
        code: error.code,
        message: error.message,
        details: error.details || 'No additional details'
      },
      troubleshooting: {
        'UNAUTHENTICATED': 'Check if Firestore API is enabled in Google Cloud Console and if service account has permissions',
        'PERMISSION_DENIED': 'Service account lacks Firestore read/write permissions. Check Cloud IAM roles',
        'NOT_FOUND': 'Firestore database not found. Check if Firestore is initialized in Firebase Console',
        'INVALID_ARGUMENT': 'Check collection and document names for special characters'
      }
    });
  }
});

// ==================== MONGODB DATA ROUTES ====================

app.get('/api/verify-account', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const email = req.user.email || '';
    const userDoc = await User.findOne({ uid: userId }).lean();

    if (!userDoc) {
      return res.json({
        exists: false,
        message: `Account not found. Please create an account using the mobile app.\n\nUser ID: ${userId}\nEmail: ${email}`,
      });
    }

    maybeSendWelcomeEmailForUser({
      userId,
      fallbackEmail: email,
    }).catch((e) => {
      console.warn(`⚠️ Welcome email pipeline error for ${userId}: ${e.message}`);
    });

    if (userDoc.email && email && userDoc.email !== email) {
      return res.json({
        exists: false,
        message: `Email mismatch.\n\nMongoDB: ${userDoc.email}\nGoogle: ${email}\n\nPlease use the correct Google account.`,
      });
    }

    return res.json({
      exists: true,
      user: {
        id: userId,
        email,
        name: userDoc.name || userDoc.displayName,
        photoURL: userDoc.photoURL,
        gender: userDoc.gender,
        createdAt: userDoc.createdAt,
      },
    });
  } catch (error) {
    console.error('❌ Error verifying account (MongoDB route):', error);
    return res.status(500).json({
      exists: false,
      error: 'Internal server error',
      message: `Failed to verify account: ${error.message}`,
    });
  }
});

app.post('/api/auth/register', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const email = String(req.body?.email || req.user.email || '').trim();
    const displayName = String(
      req.body?.displayName || req.user.name || req.user.displayName || 'User'
    ).trim();
    // Prioritize user upload, then Google picture only if nothing provided
    const photoURL = String(req.body?.photoURL || req.user.picture || '').trim();

    const userDoc = await ensureMongoUserRecord({
      uid: userId,
      email,
      displayName,
      photoURL,
      isProfileComplete: false,
    });

    return res.json({
      success: true,
      data: serializeUser(userDoc),
    });
  } catch (error) {
    console.error('❌ Error in POST /api/auth/register:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to register user',
      message: error.message,
    });
  }
});

app.post('/api/auth/complete-profile', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const existingUser = await User.findOne({ uid: userId }).lean();
    const mergedData = {
      ...(existingUser || buildDefaultUserData({ uid: userId })),
      ...req.body,
      uid: userId,
      email: String(req.body?.email || existingUser?.email || req.user.email || '').trim(),
      displayName: String(
        req.body?.displayName || existingUser?.displayName || req.user.name || 'User'
      ).trim(),
      // Prioritize: if user uploads new pic use it, otherwise keep database pic, only fallback to Google if absolutely no pic exists
      photoURL: String(
        req.body?.photoURL ||
        existingUser?.photoURL ||
        (req.user.picture && !existingUser?.photoURL ? req.user.picture : '') ||
        ''
      ).trim(),
    };

    const fieldsToUpdate = normalizeUserWritePayload(mergedData);
    fieldsToUpdate.isProfileComplete = true;

    // Build default data only for fields on insert (avoid conflicts with $set)
    const defaultData = buildDefaultUserData({
      uid: userId,
      email: fieldsToUpdate.email,
      displayName: fieldsToUpdate.displayName,
      photoURL: fieldsToUpdate.photoURL,
      isProfileComplete: true,
    });

    // Remove from $setOnInsert any fields that are in $set to avoid conflicts
    const setOnInsertData = {};
    for (const key in defaultData) {
      if (!(key in fieldsToUpdate)) {
        setOnInsertData[key] = defaultData[key];
      }
    }

    const userDoc = await User.findOneAndUpdate(
      { uid: userId },
      {
        $setOnInsert: setOnInsertData,
        $set: fieldsToUpdate,
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    const welcomeResult = await maybeSendWelcomeEmailForUser({
      userId,
      fallbackEmail: fieldsToUpdate.email,
    });

    return res.json({
      success: true,
      data: serializeUser(userDoc),
      welcomeEmail: welcomeResult,
    });
  } catch (error) {
    console.error('❌ Error in POST /api/auth/complete-profile:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to complete profile',
      message: error.message,
    });
  }
});

app.get('/api/users', verifyToken, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 200, 500);
    const gender = hasText(req.query.gender) ? String(req.query.gender).trim() : null;
    const minAge = Number.isFinite(Number(req.query.minAge)) ? Number(req.query.minAge) : null;
    const maxAge = Number.isFinite(Number(req.query.maxAge)) ? Number(req.query.maxAge) : null;
    const excludeUserId = hasText(req.query.excludeUserId)
      ? String(req.query.excludeUserId).trim()
      : null;
    const ids = hasText(req.query.ids)
      ? String(req.query.ids)
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
      : [];

    const query = {};

    if (ids.length > 0) {
      query.uid = { $in: ids };
    }
    if (gender) {
      query.gender = { $regex: new RegExp(`^${gender}$`, 'i') };
    }
    if (minAge !== null || maxAge !== null) {
      query.age = {};
      if (minAge !== null) {
        query.age.$gte = minAge;
      }
      if (maxAge !== null) {
        query.age.$lte = maxAge;
      }
    }
    if (excludeUserId) {
      query.uid = query.uid
        ? { ...query.uid, $nin: [excludeUserId] }
        : { $ne: excludeUserId };
    }

    const users = await User.find(query)
      .sort({ updatedAt: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    const serialized = users.map((user) => serializeUser(user)).filter(Boolean);

    return res.json({
      success: true,
      users: ids.length > 0
        ? ids
          .map((uid) => serialized.find((user) => user.uid === uid))
          .filter(Boolean)
        : serialized,
    });
  } catch (error) {
    console.error('❌ Error in GET /api/users:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch users',
      message: error.message,
    });
  }
});

app.post('/api/users/batch', verifyToken, async (req, res) => {
  try {
    const userIds = asStringList(req.body?.userIds);

    if (userIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'userIds is required',
      });
    }

    const users = await User.find({ uid: { $in: userIds } }).lean();
    const serialized = users.map((user) => serializeUser(user)).filter(Boolean);

    return res.json({
      success: true,
      users: userIds
        .map((uid) => serialized.find((user) => user.uid === uid))
        .filter(Boolean),
    });
  } catch (error) {
    console.error('❌ Error in POST /api/users/batch:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch users',
      message: error.message,
    });
  }
});

app.post('/api/users/presence/batch', verifyToken, async (req, res) => {
  try {
    const userIds = asStringList(req.body?.userIds);
    const presence = {};

    for (const userId of userIds) {
      presence[userId] = await getPresencePayload(userId);
    }

    return res.json({
      success: true,
      presence,
    });
  } catch (error) {
    console.error('❌ Error in POST /api/users/presence/batch:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch presence',
      message: error.message,
    });
  }
});

app.post('/api/users/:userId/view', verifyToken, async (req, res) => {
  try {
    const ownerUserId = req.params.userId;
    const viewerId = req.user.uid;

    if (!ownerUserId || ownerUserId === viewerId) {
      return res.json({ success: true });
    }

    await Promise.all([
      ProfileView.findOneAndUpdate(
        { ownerUserId, viewerId },
        {
          $set: { viewedAt: new Date() },
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        }
      ),
      User.updateOne(
        { uid: ownerUserId },
        {
          $inc: { profileViews: 1 },
          $set: { lastViewedAt: new Date() },
        }
      ),
    ]);

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in POST /api/users/:userId/view:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to track profile view',
      message: error.message,
    });
  }
});

app.get('/api/users/:userId/views', verifyToken, async (req, res) => {
  try {
    const userDoc = await User.findOne({ uid: req.params.userId }).lean();
    return res.json({
      success: true,
      count: userDoc?.profileViews || 0,
    });
  } catch (error) {
    console.error('❌ Error in GET /api/users/:userId/views:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get profile views',
      message: error.message,
    });
  }
});

app.get('/api/users/:userId/viewers', verifyToken, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50, 200);
    const ownerUserId = req.params.userId;
    const viewerRows = await ProfileView.find({ ownerUserId })
      .sort({ viewedAt: -1 })
      .limit(limit)
      .lean();

    const viewerIds = viewerRows.map((row) => row.viewerId);
    const viewerDocs = await User.find({ uid: { $in: viewerIds } }).lean();
    const viewerMap = new Map(
      viewerDocs.map((doc) => [doc.uid, serializeUser(doc)])
    );

    const viewers = viewerRows
      .map((row) => {
        const viewer = viewerMap.get(row.viewerId);
        if (!viewer) {
          return null;
        }

        return {
          id: row.viewerId,
          displayName: viewer.displayName || 'Unknown',
          photoURL: viewer.photoURL || '',
          age: viewer.age || 0,
          verified: viewer.verified === true,
          viewedAt: row.viewedAt,
        };
      })
      .filter(Boolean);

    return res.json({
      success: true,
      viewers,
    });
  } catch (error) {
    console.error('❌ Error in GET /api/users/:userId/viewers:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get profile viewers',
      message: error.message,
    });
  }
});

app.get('/api/users/:userId/presence', verifyToken, async (req, res) => {
  try {
    const payload = await getPresencePayload(req.params.userId);
    return res.json({
      success: true,
      ...payload,
    });
  } catch (error) {
    console.error('❌ Error in GET /api/users/:userId/presence:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to get presence',
      message: error.message,
    });
  }
});

app.get('/api/users/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId || userId.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid user ID',
        message: 'User ID cannot be empty',
      });
    }

    const userDoc = await User.findOne({ uid: userId }).lean();
    if (!userDoc) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        message: `User profile not found for ID: ${userId}`,
      });
    }

    return res.json({
      success: true,
      data: serializeUser(userDoc),
    });
  } catch (error) {
    console.error('❌ Error in GET /api/users/:userId:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      code: error.code || 'UNKNOWN',
    });
  }
});

app.put('/api/users/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body || {};

    if (req.user.uid !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
        message: 'You can only update your own profile',
      });
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'No fields provided for update',
      });
    }

    const existingUser = await User.findOne({ uid: userId }).lean();
    if (!existingUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        message: `User profile does not exist for ID: ${userId}`,
      });
    }

    const mergedData = {
      ...existingUser,
      ...updates,
      uid: userId,
    };
    const fieldsToUpdate = normalizeUserWritePayload(mergedData);
    fieldsToUpdate.isProfileComplete =
      updates.isProfileComplete === true ||
      existingUser.isProfileComplete === true ||
      isProfileDataComplete(mergedData);

    const userDoc = await User.findOneAndUpdate(
      { uid: userId },
      { $set: fieldsToUpdate },
      { new: true }
    );

    const welcomeResult = await maybeSendWelcomeEmailForUser({
      userId,
      fallbackEmail: req.user.email || '',
    });

    return res.json({
      success: true,
      message: 'User profile updated successfully',
      data: serializeUser(userDoc),
      welcomeEmail: welcomeResult,
    });
  } catch (error) {
    console.error('❌ Error in PUT /api/users/:userId:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      code: error.code || 'UNKNOWN',
    });
  }
});

app.post('/api/likes', verifyToken, async (req, res) => {
  try {
    const fromUserId = req.user.uid;
    const toUserId = String(req.body?.toUserId || '').trim();

    if (!toUserId || toUserId === fromUserId) {
      return res.status(400).json({
        success: false,
        error: 'Invalid target user',
      });
    }

    const [fromUser, toUser] = await Promise.all([
      User.findOne({ uid: fromUserId }).lean(),
      User.findOne({ uid: toUserId }).lean(),
    ]);

    if (!fromUser || !toUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const fromUserName = String(
      req.body?.fromUserName || fromUser.displayName || req.user.name || 'User'
    ).trim();
    const fromUserPhoto = String(
      req.body?.fromUserPhoto || fromUser.photoURL || req.user.picture || ''
    ).trim();

    const likeId = `${fromUserId}_${toUserId}`;
    const likeDoc = await Like.findOneAndUpdate(
      { likeId },
      {
        $setOnInsert: {
          likeId,
          fromUserId,
          toUserId,
          fromUserName,
          fromUserPhoto,
          timestamp: new Date(),
          isRead: false,
        },
      },
      {
        upsert: true,
        new: true,
        setDefaultsOnInsert: true,
      }
    );

    // Track whether this like was newly created (not a duplicate)
    const isNewLike = likeDoc.timestamp && (Date.now() - new Date(likeDoc.timestamp).getTime()) < 5000;

    await Promise.all([
      User.updateOne(
        { uid: fromUserId },
        { $addToSet: { likedUsers: toUserId } }
      ),
      User.updateOne(
        { uid: toUserId },
        { $addToSet: { likedBy: fromUserId } }
      ),
    ]);

    const reciprocalLike = await Like.findOne({
      likeId: `${toUserId}_${fromUserId}`,
    }).lean();

    let matchId = null;
    if (reciprocalLike) {
      matchId = await ensureActiveMatch(fromUserId, toUserId);

      // Send mutual match notification to BOTH users (fire-and-forget)
      setImmediate(() => {
        push.newMatch({
          userId1: fromUserId,
          userId2: toUserId,
          userName1: fromUserName,
          userName2: toUser.displayName || 'someone',
          matchId: String(matchId || ''),
        }).catch(() => {});
      });
    } else if (isNewLike) {
      // Send like notification to the receiver (fire-and-forget)
      setImmediate(() => {
        push.newLike({
          toUserId,
          fromUserId,
          fromUserName,
          fromUserPhoto,
        }).catch(() => {});
      });
    }

    return res.json({
      success: true,
      like: sanitizeMongoDoc(likeDoc),
      isMutual: !!reciprocalLike,
      matchId,
    });
  } catch (error) {
    console.error('❌ Error in POST /api/likes:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to send like',
      message: error.message,
    });
  }
});

app.get('/api/likes/received', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = parseLimit(req.query.limit, 50, 200);
    const likes = await Like.find({ toUserId: userId })
      .sort({ timestamp: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      likes: likes.map((like) => ({
        ...sanitizeMongoDoc(like),
        timestamp: like.timestamp instanceof Date
          ? like.timestamp.toISOString()
          : like.timestamp,
      })),
    });
  } catch (error) {
    console.error('❌ Error in GET /api/likes/received:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch received likes',
      message: error.message,
    });
  }
});

app.get('/api/likes/status/:otherUserId', verifyToken, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const otherUserId = req.params.otherUserId;

    const [directLike, reverseLike] = await Promise.all([
      Like.findOne({ likeId: `${currentUserId}_${otherUserId}` }).lean(),
      Like.findOne({ likeId: `${otherUserId}_${currentUserId}` }).lean(),
    ]);

    return res.json({
      success: true,
      liked: !!directLike,
      mutual: !!directLike && !!reverseLike,
    });
  } catch (error) {
    console.error('❌ Error in GET /api/likes/status/:otherUserId:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch like status',
      message: error.message,
    });
  }
});

app.post('/api/likes/read', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const fromUserId = String(req.body?.fromUserId || '').trim();

    if (!fromUserId) {
      return res.status(400).json({
        success: false,
        error: 'fromUserId is required',
      });
    }

    await Like.updateOne(
      { likeId: `${fromUserId}_${userId}` },
      {
        $set: {
          isRead: true,
          readAt: new Date(),
        },
      }
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in POST /api/likes/read:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to mark like as read',
      message: error.message,
    });
  }
});

app.delete('/api/likes/:otherUserId', verifyToken, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const otherUserId = req.params.otherUserId;

    await Promise.all([
      Like.deleteOne({ likeId: `${currentUserId}_${otherUserId}` }),
      User.updateOne(
        { uid: currentUserId },
        { $pull: { likedUsers: otherUserId } }
      ),
      User.updateOne(
        { uid: otherUserId },
        { $pull: { likedBy: currentUserId } }
      ),
    ]);

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in DELETE /api/likes/:otherUserId:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to unlike user',
      message: error.message,
    });
  }
});

// ==================== BLOCK/UNBLOCK ENDPOINTS ====================

app.post('/api/users/:uid/block/:targetUid', verifyToken, async (req, res) => {
  try {
    const blocker = req.user.uid;
    const blocked = req.params.targetUid;

    if (!blocked || blocked === blocker) {
      return res.status(400).json({
        success: false,
        error: 'Invalid target user',
        message: 'Cannot block yourself',
      });
    }

    const blockedUser = await User.findOne({ uid: blocked }).lean();
    if (!blockedUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        message: `User profile not found for ID: ${blocked}`,
      });
    }

    // Add to blockedUsers array and add to their blockedBy array
    await Promise.all([
      User.updateOne(
        { uid: blocker },
        {
          $addToSet: { blockedUsers: blocked },
          // Also remove from matches and likes
          $pull: {
            likedUsers: blocked,
            likedBy: blocked,
            matches: blocked,
          },
        }
      ),
      User.updateOne(
        { uid: blocked },
        {
          $addToSet: { blockedBy: blocker },
          // Also remove from their matches and likes to blocked user
          $pull: {
            likedUsers: blocker,
            likedBy: blocker,
            matches: blocker,
          },
        }
      ),
      // Clean up like documents
      Like.deleteMany({
        $or: [
          { likeId: `${blocker}_${blocked}` },
          { likeId: `${blocked}_${blocker}` },
        ],
      }),
      // Clean up match document
      Match.deleteOne({
        matchId: getMatchId(blocker, blocked),
      }),
    ]);

    return res.json({
      success: true,
      message: `Successfully blocked user: ${blocked}`,
    });
  } catch (error) {
    console.error('❌ Error in POST /api/users/:uid/block/:targetUid:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to block user',
      message: error.message,
    });
  }
});

app.post('/api/users/:uid/unblock/:targetUid', verifyToken, async (req, res) => {
  try {
    const unblocking = req.user.uid;
    const toUnblock = req.params.targetUid;

    if (!toUnblock || toUnblock === unblocking) {
      return res.status(400).json({
        success: false,
        error: 'Invalid target user',
      });
    }

    const targetUser = await User.findOne({ uid: toUnblock }).lean();
    if (!targetUser) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
        message: `User profile not found for ID: ${toUnblock}`,
      });
    }

    // Remove from blockedUsers and blockedBy arrays
    await Promise.all([
      User.updateOne(
        { uid: unblocking },
        { $pull: { blockedUsers: toUnblock } }
      ),
      User.updateOne(
        { uid: toUnblock },
        { $pull: { blockedBy: unblocking } }
      ),
    ]);

    return res.json({
      success: true,
      message: `Successfully unblocked user: ${toUnblock}`,
    });
  } catch (error) {
    console.error('❌ Error in POST /api/users/:uid/unblock/:targetUid:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to unblock user',
      message: error.message,
    });
  }
});

app.get('/api/users/:uid/blocked', verifyToken, async (req, res) => {
  try {
    const userId = req.params.uid;
    const limit = parseLimit(req.query.limit, 100, 300);

    if (req.user.uid !== userId) {
      return res.status(403).json({
        success: false,
        error: 'Unauthorized',
        message: 'You can only view your own blocked list',
      });
    }

    const userDoc = await User.findOne({ uid: userId })
      .select('blockedUsers')
      .lean();

    if (!userDoc) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const blockedUserIds = (userDoc.blockedUsers || []).slice(0, limit);
    const blockedUsers = await User.find({ uid: { $in: blockedUserIds } })
      .select('uid displayName photoURL age gender verified')
      .lean();

    const serialized = blockedUsers.map((user) => ({
      uid: user.uid,
      displayName: user.displayName,
      photoURL: user.photoURL,
      age: user.age,
      gender: user.gender,
      verified: user.verified,
    }));

    return res.json({
      success: true,
      blockedUsers: serialized,
      count: userDoc.blockedUsers?.length || 0,
    });
  } catch (error) {
    console.error('❌ Error in GET /api/users/:uid/blocked:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch blocked users',
      message: error.message,
    });
  }
});

app.post('/api/users/:uid/is-blocked/:targetUid', verifyToken, async (req, res) => {
  try {
    const userId = req.params.uid;
    const targetUid = req.params.targetUid;

    const userDoc = await User.findOne({ uid: userId })
      .select('blockedUsers blockedBy')
      .lean();

    if (!userDoc) {
      return res.status(404).json({
        success: false,
        error: 'User not found',
      });
    }

    const isBlocked = (userDoc.blockedUsers || []).includes(targetUid);
    const hasBlockedByTarget = (userDoc.blockedBy || []).includes(targetUid);

    return res.json({
      success: true,
      blockedByMe: isBlocked,
      blockedMe: hasBlockedByTarget,
    });
  } catch (error) {
    console.error('❌ Error in POST /api/users/:uid/is-blocked/:targetUid:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to check block status',
      message: error.message,
    });
  }
});

app.get('/api/matches', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = parseLimit(req.query.limit, 100, 300);
    const matches = await Match.find({
      participants: userId,
      status: 'active',
    })
      .sort({ updatedAt: -1, timestamp: -1 })
      .limit(limit)
      .lean();

    return res.json({
      success: true,
      matches: matches.map((match) => {
        const partnerId =
          match.user1Id === userId ? match.user2Id : match.user1Id;
        return {
          ...sanitizeMongoDoc(match),
          partnerUserId: partnerId,
        };
      }),
    });
  } catch (error) {
    console.error('❌ Error in GET /api/matches:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to fetch matches',
      message: error.message,
    });
  }
});

app.post('/api/matches/unmatch', verifyToken, async (req, res) => {
  try {
    const currentUserId = req.user.uid;
    const partnerUserId = String(req.body?.userId || '').trim();

    if (!partnerUserId) {
      return res.status(400).json({
        success: false,
        error: 'userId is required',
      });
    }

    const matchId = getMatchId(currentUserId, partnerUserId);

    await Promise.all([
      Match.updateOne(
        { matchId },
        {
          $set: {
            status: 'deleted',
            deletedAt: new Date(),
          },
        }
      ),
      User.updateOne(
        { uid: currentUserId },
        { $pull: { matches: partnerUserId } }
      ),
      User.updateOne(
        { uid: partnerUserId },
        { $pull: { matches: currentUserId } }
      ),
    ]);

    return res.json({ success: true });
  } catch (error) {
    console.error('❌ Error in POST /api/matches/unmatch:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to unmatch user',
      message: error.message,
    });
  }
});

// ==================== WEB APP VERIFICATION ====================

// Redundant Firestore user routes removed. MongoDB versions at lines 1027-1516 are active.


// ==================== NOTIFICATION ROUTES ====================

// Send push notification
app.post('/api/notifications/send', verifyToken, async (req, res) => {
  try {
    const { token, title, body, data } = req.body;

    if (!token || !title || !body) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // FCM requires all data values to be strings
    const stringData = {};
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        stringData[k] = String(v ?? '');
      }
    }

    const type = stringData.type || '';
    const channelId = (type === 'like' || type === 'match') ? 'matches' : 'messages';

    const message = {
      notification: { title, body },
      data: stringData,
      token,
      // Deliver instantly even when phone is in Doze/background (like WhatsApp)
      android: {
        priority: 'high',
        notification: {
          channelId,
          priority: 'high',
          defaultSound: true,
          defaultVibrateTimings: true,
        },
      },
      apns: {
        headers: {
          'apns-priority': '10',
          'apns-push-type': 'alert',
        },
        payload: {
          aps: {
            sound: 'default',
            badge: 1,
            contentAvailable: true,
          },
        },
      },
    };

    const response = await admin.messaging().send(message);

    res.json({
      success: true,
      messageId: response,
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Failed to send notification', message: error.message });
  }
});

// ==================== CHAT ROUTES ====================

// Create or get chat
app.post('/api/chats/create', verifyToken, async (req, res) => {
  try {
    const { participantIds } = req.body;

    if (!participantIds || participantIds.length !== 2) {
      return res.status(400).json({ error: 'Invalid participants' });
    }

    // Check if chat already exists
    const existingChat = await db.collection('chats')
      .where('participants', 'array-contains', req.user.uid)
      .get();

    let chatId = null;
    existingChat.forEach(doc => {
      const data = doc.data();
      if (data.participants.includes(participantIds[1])) {
        chatId = doc.id;
      }
    });

    // Create new chat if doesn't exist
    if (!chatId) {
      const chatRef = await db.collection('chats').add({
        participants: participantIds,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        lastMessage: {
          text: '',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          senderId: ''
        }
      });
      chatId = chatRef.id;
    }

    res.json({
      success: true,
      chatId
    });
  } catch (error) {
    console.error('Error creating chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== MESSAGE QUEUE ROUTES ====================

// Send message (stores in MongoDB if receiver is offline)
app.post('/api/messages/send', verifyToken, async (req, res) => {
  try {
    const { receiverId, chatId, messageType, content, mediaUrl, thumbnailUrl, metadata } = req.body;

    if (!receiverId || !chatId || !content) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Generate unique message ID
    const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Check if receiver is online (you can implement your own online status logic)
    // For now, we'll always store in MongoDB first

    try {
      const encryptedPayload = encryptMessageContent(content);

      // Store message in MongoDB
      const pendingMessage = new PendingMessage({
        messageId,
        senderId: req.user.uid,
        receiverId,
        chatId,
        messageType: messageType || 'text',
        content: encryptedPayload.content,
        mediaUrl,
        thumbnailUrl,
        status: 'pending',
        metadata: {
          ...(metadata || {}),
          enc: encryptedPayload.enc,
        }
      });

      await pendingMessage.save();

      // Receiver may have internet but app closed/background: notify via FCM.
      await push.newMessage({
        receiverId,
        senderId: req.user.uid,
        chatId,
        messageId,
        messageType: messageType || 'text',
        content,
      });

      res.json({
        success: true,
        messageId,
        status: 'queued'
      });
    } catch (dbError) {
      console.error('MongoDB error:', dbError);
      res.status(500).json({ error: 'Failed to queue message' });
    }
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get pending messages for current user (when they come online)
app.get('/api/messages/pending', verifyToken, async (req, res) => {
  try {
    const pendingMessages = await PendingMessage.getPendingMessagesForUser(req.user.uid);

    res.json({
      success: true,
      count: pendingMessages.length,
      messages: pendingMessages.map(serializePendingMessageForClient)
    });
  } catch (error) {
    console.error('Error fetching pending messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get pending messages for a specific chat
app.get('/api/messages/pending/:chatId', verifyToken, async (req, res) => {
  try {
    const { chatId } = req.params;

    // Verify user is part of the chat
    const chatDoc = await db.collection('chats').doc(chatId).get();
    if (!chatDoc.exists) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const chatData = chatDoc.data();
    if (!chatData.participants.includes(req.user.uid)) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const pendingMessages = await PendingMessage.getPendingMessagesByChat(chatId);

    res.json({
      success: true,
      count: pendingMessages.length,
      messages: pendingMessages.map(serializePendingMessageForClient)
    });
  } catch (error) {
    console.error('Error fetching chat messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Mark messages as delivered (after saving to local SQLite)
app.post('/api/messages/delivered', verifyToken, async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds) || messageIds.length === 0) {
      return res.status(400).json({ error: 'Invalid messageIds' });
    }

    // Mark all messages as delivered
    const results = await Promise.allSettled(
      messageIds.map(async (messageId) => {
        const message = await PendingMessage.findOne({
          messageId,
          receiverId: req.user.uid,
          status: 'pending'
        });

        if (message) {
          return await message.markAsDelivered();
        }
        return null;
      })
    );

    const successCount = results.filter(r => r.status === 'fulfilled' && r.value).length;

    res.json({
      success: true,
      delivered: successCount,
      total: messageIds.length
    });
  } catch (error) {
    console.error('Error marking messages as delivered:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete delivered messages (cleanup after confirmed local storage)
app.delete('/api/messages/cleanup', verifyToken, async (req, res) => {
  try {
    const { messageIds } = req.body;

    if (!messageIds || !Array.isArray(messageIds)) {
      return res.status(400).json({ error: 'Invalid messageIds' });
    }

    // Delete only delivered messages for this user
    const result = await PendingMessage.deleteMany({
      messageId: { $in: messageIds },
      receiverId: req.user.uid,
      status: 'delivered'
    });

    res.json({
      success: true,
      deleted: result.deletedCount
    });
  } catch (error) {
    console.error('Error cleaning up messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Check connection status and sync
app.post('/api/messages/sync', verifyToken, async (req, res) => {
  try {
    // Get all pending messages
    const pendingMessages = await PendingMessage.getPendingMessagesForUser(req.user.uid);

    // Get message counts by chat
    const chatCounts = {};
    pendingMessages.forEach(msg => {
      chatCounts[msg.chatId] = (chatCounts[msg.chatId] || 0) + 1;
    });

    res.json({
      success: true,
      totalPending: pendingMessages.length,
      chatCounts,
      messages: pendingMessages.map(serializePendingMessageForClient)
    });
  } catch (error) {
    console.error('Error syncing messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get message queue statistics (for debugging/monitoring)
app.get('/api/messages/stats', verifyToken, async (req, res) => {
  try {
    const stats = await PendingMessage.aggregate([
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    const userPendingCount = await PendingMessage.countDocuments({
      receiverId: req.user.uid,
      status: 'pending'
    });

    res.json({
      success: true,
      globalStats: stats,
      userPendingCount
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== ADMIN ROUTES ====================

// Get all users (admin only)
app.get('/api/admin/users', verifyToken, async (req, res) => {
  try {
    const adminUser = await User.findOne({ uid: req.user.uid }).lean();
    if (!adminUser || !adminUser.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized - Admin only' });
    }

    const users = await User.find({}).limit(100).sort({ createdAt: -1 }).lean();
    const serialized = users.map(u => serializeUser(u));

    res.json({
      success: true,
      data: serialized,
      count: serialized.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Delete user (admin only)
app.delete('/api/admin/users/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;

    const adminUser = await User.findOne({ uid: req.user.uid }).lean();
    if (!adminUser || !adminUser.isAdmin) {
      return res.status(403).json({ error: 'Unauthorized - Admin only' });
    }

    // Delete from Firebase Auth
    await auth.deleteUser(userId);

    // Delete from MongoDB
    await User.deleteOne({ uid: userId });

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== STORAGE ROUTES ====================

// Generate signed URL for file upload
app.post('/api/storage/upload-url', verifyToken, async (req, res) => {
  try {
    const { fileName, contentType } = req.body;

    if (!fileName || !contentType) {
      return res.status(400).json({ error: 'Missing fileName or contentType' });
    }

    const bucket = storage.bucket();
    const file = bucket.file(`uploads/${req.user.uid}/${Date.now()}_${fileName}`);

    const [url] = await file.getSignedUrl({
      version: 'v4',
      action: 'write',
      expires: Date.now() + 15 * 60 * 1000, // 15 minutes
      contentType
    });

    res.json({
      success: true,
      uploadUrl: url,
      filePath: file.name
    });
  } catch (error) {
    console.error('Error generating upload URL:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ==================== STATUS/STORIES ROUTES ====================

// Post a new story
app.post('/api/statuses', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { content, mediaUrl, mediaType = 'image', mediaSize, duration, visibility = 'public', allowComments = true } = req.body;

    const user = await User.findOne({ uid: userId }).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const storyId = `${userId}_${Date.now()}`;
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const status = await Status.create({
      storyId,
      userId,
      userName: user.displayName || 'User',
      userPhoto: user.photoURL || '',
      content: String(content || '').trim(),
      mediaUrl,
      mediaType,
      mediaSize,
      duration,
      visibility,
      allowComments,
      expiresAt,
      views: [],
      viewsCount: 0,
    });

    res.json({
      success: true,
      data: sanitizeMongoDoc(status),
    });
  } catch (error) {
    console.error('❌ Error posting story:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get stories feed (for discovery)
app.get('/api/statuses/feed', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = parseLimit(req.query.limit, 50, 200);

    const stories = await Status.find({
      status: 'active',
      expiresAt: { $gt: new Date() },
      $or: [
        { visibility: 'public' },
        { userId },
        { linkedMatches: { $in: await User.findOne({ uid: userId }).select('matches').lean().then(u => u?.matches || []) } }
      ]
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      stories: stories.map(s => sanitizeMongoDoc(s)),
    });
  } catch (error) {
    console.error('❌ Error fetching stories:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get user's stories
app.get('/api/statuses/user/:userId', verifyToken, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 50, 200);
    const stories = await Status.find({
      userId: req.params.userId,
      status: 'active',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      stories: stories.map(s => sanitizeMongoDoc(s)),
    });
  } catch (error) {
    console.error('❌ Error fetching user stories:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// View a story
app.post('/api/statuses/:storyId/view', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const storyId = req.params.storyId;

    const status = await Status.findOneAndUpdate(
      { storyId },
      {
        $addToSet: { views: userId },
        $inc: { viewsCount: 1 },
      },
      { new: true }
    );

    if (!status) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error recording story view:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// React to story
app.post('/api/statuses/:storyId/react', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const storyId = req.params.storyId;
    const { emoji } = req.body;

    if (!emoji) {
      return res.status(400).json({ success: false, error: 'Emoji required' });
    }

    const status = await Status.findOneAndUpdate(
      { storyId },
      {
        $addToSet: { [`reactions.${emoji}`]: userId },
      },
      { new: true }
    );

    if (!status) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    res.json({ success: true, data: sanitizeMongoDoc(status) });
  } catch (error) {
    console.error('❌ Error reacting to story:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Delete story
app.delete('/api/statuses/:storyId', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const storyId = req.params.storyId;

    const status = await Status.findOne({ storyId }).select('userId').lean();
    if (!status) {
      return res.status(404).json({ success: false, error: 'Story not found' });
    }

    if (status.userId !== userId) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    await Status.findOneAndUpdate(
      { storyId },
      { $set: { status: 'deleted', deletedAt: new Date() } }
    );

    res.json({ success: true, message: 'Story deleted' });
  } catch (error) {
    console.error('❌ Error deleting story:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ADS ROUTES ====================

// Create ad (advertiser only)
app.post('/api/ads', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const {
      title,
      description,
      imageUrl,
      videoUrl,
      adType = 'banner',
      callToAction,
      targetAudience,
      budget,
      schedule,
    } = req.body;

    const user = await User.findOne({ uid: userId }).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }

    const adId = `ad_${userId}_${Date.now()}`;

    const ad = await Ad.create({
      adId,
      advertiserId: userId,
      advertiserName: user.displayName || 'Advertiser',
      title,
      description,
      imageUrl,
      videoUrl,
      adType,
      callToAction,
      targetAudience,
      budget,
      schedule,
      status: 'draft',
    });

    res.json({
      success: true,
      data: sanitizeMongoDoc(ad),
    });
  } catch (error) {
    console.error('❌ Error creating ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get ads (for display)
app.get('/api/ads', verifyToken, async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 20, 100);
    const adType = req.query.adType || 'banner';

    const now = new Date();
    const ads = await Ad.find({
      status: 'active',
      isActive: true,
      'schedule.startDate': { $lte: now },
      'schedule.endDate': { $gte: now },
      adType,
    })
      .sort({ priority: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      ads: ads.map(a => sanitizeMongoDoc(a)),
    });
  } catch (error) {
    console.error('❌ Error fetching ads:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get advertiser's ads
app.get('/api/ads/advertiser/my-ads', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const limit = parseLimit(req.query.limit, 50, 200);

    const ads = await Ad.find({ advertiserId: userId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({
      success: true,
      ads: ads.map(a => sanitizeMongoDoc(a)),
    });
  } catch (error) {
    console.error('❌ Error fetching ads:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Update ad
app.put('/api/ads/:adId', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const adId = req.params.adId;
    const updates = req.body;

    const ad = await Ad.findOne({ adId }).select('advertiserId').lean();
    if (!ad) {
      return res.status(404).json({ success: false, error: 'Ad not found' });
    }

    if (ad.advertiserId !== userId) {
      return res.status(403).json({ success: false, error: 'Unauthorized' });
    }

    const updated = await Ad.findOneAndUpdate(
      { adId },
      { $set: { ...updates, updatedAt: new Date() } },
      { new: true }
    );

    res.json({
      success: true,
      data: sanitizeMongoDoc(updated),
    });
  } catch (error) {
    console.error('❌ Error updating ad:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Log ad interaction
app.post('/api/ads/:adId/interact', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const adId = req.params.adId;
    const { eventType = 'impression', placement = 'discovery_feed' } = req.body;

    const ad = await Ad.findOne({ adId }).lean();
    if (!ad) {
      return res.status(404).json({ success: false, error: 'Ad not found' });
    }

    const analyticsId = `${adId}_${userId}_${Date.now()}`;
    await Analytics.create({
      analyticsId,
      adId,
      userId,
      eventType,
      placement,
      adFormat: ad.adType,
      timestamp: new Date(),
      date: new Date(new Date().setHours(0, 0, 0, 0)),
    });

    // Update ad metrics
    const updateOps = {};
    if (eventType === 'impression') {
      updateOps['analytics.impressions'] = 1;
      updateOps['metrics.viewedByUsers'] = userId;
    } else if (eventType === 'click') {
      updateOps['analytics.clicks'] = 1;
      updateOps['metrics.clickedByUsers'] = userId;
    } else if (eventType === 'conversion') {
      updateOps['analytics.conversions'] = 1;
      updateOps['metrics.convertedByUsers'] = userId;
    }

    if (Object.keys(updateOps).length > 0) {
      await Ad.updateOne(
        { adId },
        { $inc: updateOps, $addToSet: updateOps },
        { multi: true }
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('❌ Error logging ad interaction:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ANALYTICS ROUTES (MongoDB) ====================

// Get analytics for ad
app.get('/api/analytics/ad/:adId', verifyToken, async (req, res) => {
  try {
    const adId = req.params.adId;
    const days = parseInt(req.query.days) || 7;

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const analytics = await Analytics.find({
      adId,
      date: { $gte: startDate },
    })
      .sort({ date: -1, timestamp: -1 })
      .lean();

    const summary = {
      impressions: 0,
      clicks: 0,
      conversions: 0,
      ctr: 0,
      uniqueUsers: new Set(),
    };

    analytics.forEach(a => {
      if (a.eventType === 'impression') summary.impressions += a.impressions || 1;
      if (a.eventType === 'click') summary.clicks += a.clicks || 1;
      if (a.eventType === 'conversion') summary.conversions += a.conversions || 1;
      if (a.userId) summary.uniqueUsers.add(a.userId);
    });

    summary.ctr = summary.impressions > 0 ? (summary.clicks / summary.impressions * 100).toFixed(2) : 0;
    summary.uniqueUsers = summary.uniqueUsers.size;

    res.json({
      success: true,
      summary,
      analytics: analytics.map(a => sanitizeMongoDoc(a)),
    });
  } catch (error) {
    console.error('❌ Error fetching analytics:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Log analytics event (MongoDB version)
app.post('/api/analytics/log', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const { event, properties = {} } = req.body;

    const analyticsId = `evt_${userId}_${Date.now()}`;
    await Analytics.create({
      analyticsId,
      adId: properties.adId || 'app',
      userId,
      eventType: event,
      ...properties,
      timestamp: new Date(),
      date: new Date(new Date().setHours(0, 0, 0, 0)),
    });

    res.json({
      success: true,
      message: 'Event logged successfully'
    });
  } catch (error) {
    console.error('❌ Error logging analytics event:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ==================== ERROR HANDLING ====================

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: 'The requested endpoint does not exist'
  });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

// ==================== START SERVER ====================

// Wrap Express in an HTTP server so Socket.IO can share the same port
const httpServer = http.createServer(app);

// ── Socket.IO setup ───────────────────────────────────────────
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  // polling MUST come first — client starts with polling then upgrades
  transports: ['polling', 'websocket'],
  pingTimeout: 30000,
  pingInterval: 10000,
  upgradeTimeout: 15000,
  allowEIO3: true, // allow older Engine.IO clients (Flutter)
});

// Track online users:  userId -> Set<socketId>
const onlineUsers = new Map();

const isUserOnline = (uid) => {
  if (!uid) return false;
  const sockets = onlineUsers.get(uid);
  return !!sockets && sockets.size > 0;
};

// Auth middleware – verify Firebase token on every connection
// Token can come from auth object (preferred) or query string (fallback)
io.use(async (socket, next) => {
  console.log(`🔌 [Socket.IO] New handshake attempt from ${socket.id} (URL: ${socket.handshake.url})`);
  try {
    const authHeader = socket.handshake.headers?.authorization || socket.handshake.headers?.Authorization;
    const headerToken = typeof authHeader === 'string' && authHeader.startsWith('Bearer ')
      ? authHeader.slice(7)
      : null;

    const token = socket.handshake.auth?.token || socket.handshake.query?.token || headerToken;
    console.log(`🔐 [Socket.IO] Auth attempt - Token present: ${!!token}, From: ${token ? (token.length > 20 ? 'auth object' : 'query string') : 'none'}`);

    if (!token) {
      console.error('❌ [Socket.IO] No token provided in auth/query/header');
      return next(new Error('No token provided'));
    }

    // DEBUG mode: allow connections without real Firebase verification
    if (process.env.DEBUG_SOCKET_AUTH === 'true') {
      console.warn('⚠️  DEBUG_SOCKET_AUTH enabled - bypassing Firebase token verification');
      socket.userId = socket.handshake.query?.userId || 'debug-user-' + Math.random().toString(36).slice(7);
      socket.userIdFromQuery = socket.handshake.query?.userId || socket.userId;
      return next();
    }

    // Verify token with timeout (max 5 seconds to prevent hanging)
    const verifyPromise = admin.auth().verifyIdToken(token);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Token verification timeout')), 5000)
    );

    const decoded = await Promise.race([verifyPromise, timeoutPromise]);
    socket.userId = decoded.uid;
    socket.userIdFromQuery = socket.handshake.query?.userId || decoded.uid;
    console.log(`✅ [Socket.IO] Token verified for user: ${socket.userId}`);
    next();
  } catch (err) {
    console.error('❌ [Socket.IO] Auth middleware failed:', err.message);
    next(new Error('Invalid or expired token: ' + err.message));
  }
});

io.on('connection', (socket) => {
  const userId = socket.userId;
  console.log(`✅ [Socket.IO] User connected: ${userId} (${socket.id})`);

  // ── Track presence ──────────────────────────────────────────
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socket.id);

  // Join a personal room so we can target this user directly
  socket.join(userId);

  User.updateOne(
    { uid: userId },
    {
      $setOnInsert: (() => {
        const defaults = buildDefaultUserData({
          uid: userId,
          email: '',
          displayName: 'User',
          photoURL: '',
          isProfileComplete: false,
        });
        // Remove fields that will be set by $set operator
        delete defaults.online;
        delete defaults.lastSeen;
        delete defaults.lastActive;
        return defaults;
      })(),
      $set: {
        online: true,
        lastSeen: null,
        lastActive: new Date(),
      },
    },
    {
      upsert: true,
      setDefaultsOnInsert: true,
    }
  ).catch((error) => {
    console.error(`❌ Failed to persist online presence for ${userId}:`, error.message);
  });

  // Broadcast online status
  socket.broadcast.emit('presence_update', { userId, status: 'online', lastSeen: null });

  // ── get_online_users ───────────────────────────────────────
  socket.on('get_online_users', () => {
    const users = Array.from(onlineUsers.entries())
      .filter(([, sockets]) => sockets && sockets.size > 0)
      .map(([uid]) => uid);
    socket.emit('online_users', users);
  });

  // ── send_message ────────────────────────────────────────────
  socket.on('send_message', async (data) => {
    try {
      const { messageId, chatId, receiverId, content, mediaUrl, messageType, timestamp, replyToId } = data;

      // 1. Always queue message in MongoDB FIRST (Status: pending)
      try {
        const exists = await PendingMessage.findOne({ messageId });
        if (!exists) {
          const encryptedPayload = encryptMessageContent(content);
          const metadata = { enc: encryptedPayload.enc };
          if (replyToId) metadata.replyToId = replyToId;

          await new PendingMessage({
            messageId,
            senderId: userId,
            receiverId,
            chatId,
            messageType: messageType || 'text',
            content: encryptedPayload.content,
            mediaUrl,
            status: 'pending',
            metadata,
          }).save();
        }
      } catch (dbErr) {
        console.error('[Socket.IO] DB error early queuing message:', dbErr.message);
      }

      // 2. Notify sender that message is "pending" (queued on server)
      socket.emit('message_status_update', { messageId, status: 'pending' });

      // 3. Deliver real-time if online
      if (isUserOnline(receiverId)) {
        io.to(receiverId).emit('new_message', {
          messageId,
          chatId,
          senderId: userId,
          receiverId,
          content,
          mediaUrl,
          messageType: messageType || 'text',
          timestamp: timestamp || Date.now(),
          replyToId,
        });
        console.log(`📤 [Socket.IO] Message ${messageId} emitted to online user ${receiverId}`);
      } else {
        // 4. Trigger push notification ONLY if offline
        await push.newMessage({
          receiverId,
          senderId: userId,
          chatId,
          messageId,
          messageType: messageType || 'text',
          content,
        });
        console.log(`📦 [Socket.IO] Message ${messageId} queued for offline user ${receiverId}`);
      }
    } catch (err) {
      console.error('[Socket.IO] send_message error:', err);
    }
  });

  // ── fetch_pending – deliver queued messages on reconnect ────
  socket.on('fetch_pending', async (data) => {
    try {
      // Always fetch all still-pending messages for this user.
      // Filtering by client sync time can accidentally skip queued offline items.
      const pending = await PendingMessage.find({
        receiverId: userId,
        status: 'pending',
      }).sort({ createdAt: 1 }).limit(200);

      if (pending.length > 0) {
        socket.emit('pending_messages', pending.map(m => ({
          messageId: m.messageId,
          chatId: m.chatId,
          senderId: m.senderId,
          content: decryptMessageContent(m.content, m.metadata),
          mediaUrl: m.mediaUrl,
          messageType: m.messageType,
          timestamp: m.createdAt.getTime(),
          replyToId: m?.metadata?.replyToId,
        })));
        console.log(`📬 [Socket.IO] Sent ${pending.length} pending messages to ${userId}`);
      }
    } catch (err) {
      console.error('[Socket.IO] fetch_pending error:', err);
    }
  });

  // ── ack – mark message as delivered ────────────────────────
  socket.on('ack', async (data) => {
    const { messageId, ackType, senderId } = data;
    if (ackType === 'delivered') {
      try {
        // Receiver came online and confirmed delivery:
        // remove from temporary queue and notify original sender.
        const deliveredMsg = await PendingMessage.findOneAndDelete({
          messageId,
          receiverId: userId,
        });

        const originalSenderId = deliveredMsg?.senderId || senderId;
        if (originalSenderId) {
          io.to(originalSenderId).emit('message_status_update', {
            messageId,
            status: 'delivered',
            deliveredTo: userId,
            timestamp: Date.now(),
          });
          io.to(originalSenderId).emit('message_delivered', {
            messageId,
            receiverId: userId,
            timestamp: Date.now(),
          });
        }
      } catch (e) { /* non-critical */ }
    }
  });

  // Backward-compatible explicit delivered event from some clients.
  socket.on('message_delivered', async (data) => {
    try {
      const { messageId, senderId } = data || {};
      if (!messageId) return;

      const deliveredMsg = await PendingMessage.findOneAndDelete({
        messageId,
        receiverId: userId,
      });

      const originalSenderId = deliveredMsg?.senderId || senderId;
      if (originalSenderId) {
        io.to(originalSenderId).emit('message_status_update', {
          messageId,
          status: 'delivered',
          deliveredTo: userId,
          timestamp: Date.now(),
        });
      }
    } catch (e) {
      console.error('[Socket.IO] message_delivered error:', e);
    }
  });

  // ── typing indicator ────────────────────────────────────────
  socket.on('typing', (data) => {
    const { receiverId, chatId, isTyping } = data;
    if (receiverId && isUserOnline(receiverId)) {
      io.to(receiverId).emit('typing_status', {
        senderId: userId,
        chatId,
        isTyping: !!isTyping,
      });
    }
  });

  // ── mark_seen ───────────────────────────────────────────────
  socket.on('mark_seen', (data) => {
    const { chatId, senderId: originalSender, messageId } = data;
    if (originalSender && onlineUsers.has(originalSender)) {
      io.to(originalSender).emit('message_seen', {
        chatId,
        messageId,
        seenBy: userId,
      });
    }
  });

  // ── video_match_start: Join queue for random video matching ──
  socket.on('video_match_start', async (data) => {
    try {
      // If already paired, end current call before entering queue again.
      terminateVideoPair(socket, {
        partnerReason: 'partner_left_for_new_match',
        selfReason: 'restarting_match',
      });

      let clientGender = null;
      let parsedData = data;
      if (typeof parsedData === 'string') {
        try { parsedData = JSON.parse(parsedData); } catch (e) { }
      }
      if (Array.isArray(parsedData) && parsedData.length > 0) {
        parsedData = parsedData[0];
      }
      if (parsedData && typeof parsedData === 'object' && parsedData.gender) {
        clientGender = parsedData.gender;
      }
      console.log(`[VideoMatch] Received video_match_start with data:`, typeof data === 'object' ? JSON.stringify(data) : data, `-> extracted gender:`, clientGender);
      await startVideoMatchForSocket(socket, clientGender);
    } catch (error) {
      console.error('[VideoMatch] Error in video_match_start:', error);
      socket.emit('video_match_error', { error: 'Failed to start matching' });
    }
  });

  // ── video_match_cancel: Leave the matching queue ──
  socket.on('video_match_cancel', () => {
    const userId = socket.userId;
    terminateVideoPair(socket, {
      partnerReason: 'partner_cancelled_matching',
      selfReason: 'cancelled',
    });
    removeSocketFromVideoQueues(socket.id);
    socket.emit('video_match_cancelled', { message: 'Matching cancelled' });
    console.log(`❌ [VideoMatch] ${userId} cancelled matching`);
  });

  // ── WebRTC signaling: offer ──
  socket.on('webrtc_offer', (data) => {
    const { offer, targetSocketId } = data;

    if (!videoCallPairs.has(socket.id) || videoCallPairs.get(socket.id) !== targetSocketId) {
      console.error('[WebRTC] Invalid offer - not paired');
      return;
    }

    io.to(targetSocketId).emit('webrtc_offer', {
      offer,
      fromSocketId: socket.id
    });

    console.log(`📞 [WebRTC] Offer sent from ${socket.id} to ${targetSocketId}`);
  });

  // ── WebRTC signaling: answer ──
  socket.on('webrtc_answer', (data) => {
    const { answer, targetSocketId } = data;

    if (!videoCallPairs.has(socket.id) || videoCallPairs.get(socket.id) !== targetSocketId) {
      console.error('[WebRTC] Invalid answer - not paired');
      return;
    }

    io.to(targetSocketId).emit('webrtc_answer', {
      answer,
      fromSocketId: socket.id
    });

    console.log(`📞 [WebRTC] Answer sent from ${socket.id} to ${targetSocketId}`);
  });

  // ── WebRTC signaling: ICE candidate ──
  socket.on('webrtc_ice_candidate', (data) => {
    const { candidate, targetSocketId } = data;

    if (!videoCallPairs.has(socket.id) || videoCallPairs.get(socket.id) !== targetSocketId) {
      console.error('[WebRTC] Invalid ICE candidate - not paired');
      return;
    }

    io.to(targetSocketId).emit('webrtc_ice_candidate', {
      candidate,
      fromSocketId: socket.id
    });

    console.log(`🧊 [WebRTC] ICE candidate sent from ${socket.id} to ${targetSocketId}`);
  });

  // ── video_call_next: Skip to next random match ──
  socket.on('video_call_next', async (data) => {
    const userId = socket.userId;

    // End current call if exists
    if (terminateVideoPair(socket, {
      partnerReason: 'partner_skipped',
      emitSelf: false,
    })) {
      console.log(`⏭️ [VideoMatch] ${userId} skipped to next`);
    }

    // End call notification
    socket.emit('video_call_ended', { reason: 'looking_for_next' });

    // Automatically search for next match (gender passed from client if available)
    setTimeout(() => {
      let clientGender = null;
      let parsedData = data;
      if (typeof parsedData === 'string') {
        try { parsedData = JSON.parse(parsedData); } catch (e) { }
      }
      if (Array.isArray(parsedData) && parsedData.length > 0) {
        parsedData = parsedData[0];
      }
      if (parsedData && typeof parsedData === 'object' && parsedData.gender) {
        clientGender = parsedData.gender;
      }
      console.log(`[VideoMatch] Received video_call_next with data:`, typeof data === 'object' ? JSON.stringify(data) : data, `-> extracted gender:`, clientGender);
      startVideoMatchForSocket(socket, clientGender).catch((error) => {
        console.error('[VideoMatch] Error finding next match:', error);
        socket.emit('video_match_error', { error: 'Failed to find next match' });
      });
    }, 500);
  });

  // ── video_call_end: End current call ──
  socket.on('video_call_end', () => {
    if (terminateVideoPair(socket, {
      partnerReason: 'partner_ended',
      selfReason: 'ended',
    })) {
      console.log(`📴 [VideoMatch] ${socket.userId} ended video call`);
    }
  });

  // ── disconnect ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
        User.updateOne(
          { uid: userId },
          {
            $set: {
              online: false,
              lastSeen: new Date(),
              lastActive: new Date(),
            },
          }
        ).catch((error) => {
          console.error(`❌ Failed to persist offline presence for ${userId}:`, error.message);
        });
        socket.broadcast.emit('presence_update', {
          userId,
          status: 'offline',
          lastSeen: Date.now(),
        });
      }
    }

    // Handle video call disconnection
    terminateVideoPair(socket, {
      partnerReason: 'partner_disconnected',
      emitSelf: false,
    });

    // Remove from waiting queues
    maleQueue.delete(socket.id);
    femaleQueue.delete(socket.id);

    console.log(`📴 [Socket.IO] User disconnected: ${userId} (${socket.id})`);
  });
});

// ==================== WEBRTC VIDEO MATCHING ====================
// Track waiting users by gender for opposite-gender matching
const maleQueue = new Map(); // socketId -> { userId, gender, socketId }
const femaleQueue = new Map();
const videoCallPairs = new Map(); // socketId -> partnerId

// STUN server configuration (Google's free STUN servers)
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun3.l.google.com:19302' },
  { urls: 'stun:stun4.l.google.com:19302' }
];

const removeSocketFromVideoQueues = (socketId) => {
  maleQueue.delete(socketId);
  femaleQueue.delete(socketId);
};

const terminateVideoPair = (
  socket,
  {
    partnerReason = 'partner_ended',
    selfReason = 'ended',
    emitSelf = true,
  } = {},
) => {
  const socketId = socket.id;
  if (!videoCallPairs.has(socketId)) {
    return null;
  }

  const partnerSocketId = videoCallPairs.get(socketId);
  videoCallPairs.delete(socketId);

  if (partnerSocketId) {
    videoCallPairs.delete(partnerSocketId);
    io.to(partnerSocketId).emit('video_call_ended', { reason: partnerReason });
  }

  if (emitSelf) {
    socket.emit('video_call_ended', { reason: selfReason });
  }

  return partnerSocketId;
};

const findNextValidPartner = (oppositeQueue, currentSocketId) => {
  while (oppositeQueue.size > 0) {
    const [partnerSocketId, partnerInfo] = oppositeQueue.entries().next().value;
    oppositeQueue.delete(partnerSocketId);

    if (partnerSocketId === currentSocketId) {
      continue;
    }

    const partnerSocket = io.sockets.sockets.get(partnerSocketId);
    if (!partnerSocket || !partnerSocket.connected) {
      continue;
    }

    if (videoCallPairs.has(partnerSocketId)) {
      continue;
    }

    return { partnerSocketId, partnerInfo, partnerSocket };
  }

  return null;
};

const startVideoMatchForSocket = async (socket, clientProvidedGender) => {
  const userId = socket.userId;

  if (!userId) {
    socket.emit('video_match_error', { error: 'User not authenticated' });
    return;
  }

  // Prevent duplicate queue entries for the same socket.
  removeSocketFromVideoQueues(socket.id);

  let gender = null;
  let userDoc = null;

  // Fetch the user profile from MongoDB to check status and gender
  try {
    userDoc = await User.findOne({ uid: userId }).select('gender isProfileComplete verified').lean();
  } catch (mongoError) {
    console.warn(`⚠️ [VideoMatch] Failed to fetch user profile for ${userId}: ${mongoError.message}`);
  }

  // Verify profile exists (may be incomplete)
  if (!userDoc) {
    socket.emit('video_match_error', {
      error: 'User profile not found in database'
    });
    console.error(`❌ [VideoMatch] User ${userId} not found in database`);
    return;
  }

  // No profile completion requirement - incomplete profiles can join video matching
  // Gender will still be validated below

  // Normalize gender: try client-provided first, then fall back to MongoDB
  if (clientProvidedGender) {
    gender = User.normalizeGender(clientProvidedGender);
  }

  if (!gender && userDoc?.gender) {
    gender = User.normalizeGender(userDoc.gender);
    console.log(`ℹ️ [VideoMatch] Fetched gender from MongoDB for user ${userId}: ${gender}`);
  }

  if (!gender) {
    socket.emit('video_match_error', {
      error: 'Gender must be set to Male or Female to use video matching'
    });
    console.error(`❌ [VideoMatch] No valid gender for user ${userId}`);
    return;
  }

  // Only allow 'male' and 'female' for opposite-gender matching
  if (!['male', 'female'].includes(gender)) {
    socket.emit('video_match_error', {
      error: 'Gender must be set to Male or Female to use video matching'
    });
    console.error(`❌ [VideoMatch] Invalid gender for ${userId}: ${gender}`);
    return;
  }

  console.log(`🎥 [VideoMatch] ${userId} (${gender}) looking for match...`);

  const userInfo = { userId, gender, socketId: socket.id };

  // Determine which queues to use for matching
  const myQueue = gender === 'male' ? maleQueue : femaleQueue;
  const oppositeQueue = gender === 'male' ? femaleQueue : maleQueue;

  const partner = findNextValidPartner(oppositeQueue, socket.id);

  if (partner) {
    // Create pair
    videoCallPairs.set(socket.id, partner.partnerSocketId);
    videoCallPairs.set(partner.partnerSocketId, socket.id);

    // Remove both from queues
    maleQueue.delete(socket.id);
    femaleQueue.delete(socket.id);
    maleQueue.delete(partner.partnerSocketId);
    femaleQueue.delete(partner.partnerSocketId);

    // Send ICE servers and match info to both parties
    socket.emit('video_match_found', {
      partnerId: partner.partnerInfo.userId,
      partnerSocketId: partner.partnerSocketId,
      iceServers: ICE_SERVERS,
      isInitiator: true // This user initiates the call
    });

    io.to(partner.partnerSocketId).emit('video_match_found', {
      partnerId: userId,
      partnerSocketId: socket.id,
      iceServers: ICE_SERVERS,
      isInitiator: false // This user receives the call
    });

    console.log(`✅ [VideoMatch] Matched ${userId} (${gender}) with ${partner.partnerInfo.userId} (${partner.partnerInfo.gender})`);
  } else {
    // No match available, add to queue
    myQueue.set(socket.id, userInfo);
    socket.emit('video_match_waiting', {
      message: 'Searching for a match...',
      queuePosition: myQueue.size
    });
    console.log(`⏳ [VideoMatch] ${userId} (${gender}) added to queue (${myQueue.size} waiting)`);
  }
};

// ── Admin Panel Integration ────────────────────────────────────
try {
  require('./admin_logic')(io, app);
} catch (e) {
  console.error('⚠️ Failed to load Admin Logic module:', e.message);
}

// Bind on 0.0.0.0 so physical devices on the same WiFi can connect
httpServer.listen(PORT, '0.0.0.0', () => {
  const os = require('os');
  const nets = os.networkInterfaces();
  const localIPs = [];
  for (const name of Object.keys(nets)) {
    // Ignore virtual and VPN adapters to prevent logging multiple tricky IPs
    const lowerName = name.toLowerCase();
    if (lowerName.includes('virtual') || lowerName.includes('vmware') ||
      lowerName.includes('wsl') || lowerName.includes('vbox') ||
      lowerName.includes('vethernet') || lowerName.includes('vpn') ||
      lowerName.includes('mcafee')) {
      continue;
    }

    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        localIPs.push(`  📱 Physical device URL: http://${net.address}:${PORT} (via ${name})`);
      }
    }
  }
  console.log(`🚀 Server running on port ${PORT} (all interfaces)`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔥 Firebase project: ${serviceAccount.project_id}`);
  console.log(`🔌 Socket.IO ready`);
  console.log(`  💻 Emulator URL:  http://10.0.2.2:${PORT}`);
  localIPs.forEach(l => console.log(l));
  console.log(`  ℹ️  Update _localPcIp in lib/config/app_config.dart with the 📱 URL above`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('SIGINT signal received: closing HTTP server');
  process.exit(0);
});
