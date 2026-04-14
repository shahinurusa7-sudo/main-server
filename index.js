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
const packageJson = require('./package.json');

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
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
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
      <div style="padding:28px 30px;background:linear-gradient(120deg,#0f766e,#0f172a);color:#ffffff;">
        <h1 style="margin:0;font-size:24px;line-height:1.2;">Welcome to ${safeCompany}</h1>
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
        <a href="${safeLoginUrl}" style="display:inline-block;background:#0f766e;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;font-size:14px;">Open ${safeCompany}</a>
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

  const userRef = db.collection('users').doc(userId);
  let candidate = null;
  let firestoreData = null;

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(userRef);
    if (!snap.exists) {
      return;
    }

    const data = snap.data() || {};
    firestoreData = data;
    if (data.welcomeEmailSentAt || data.welcomeEmailLockAt) {
      return;
    }

    const email = String(data.email || fallbackEmail || '').trim();
    if (!email) {
      return;
    }

    candidate = {
      email,
      userName: getDisplayNameFromUserData(data, email),
    };

    tx.set(userRef, {
      welcomeEmailLockAt: admin.firestore.FieldValue.serverTimestamp(),
      welcomeEmailRecipient: email,
    }, { merge: true });
  });

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
      await userRef.set({
        welcomeEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
        welcomeEmailError: admin.firestore.FieldValue.delete(),
        welcomeEmailLockAt: admin.firestore.FieldValue.delete(),
      }, { merge: true });
      return { status: 'sent' };
    }

    await userRef.set({
      welcomeEmailError: result.reason || 'unknown',
      welcomeEmailLockAt: admin.firestore.FieldValue.delete(),
    }, { merge: true });
    return { status: 'failed', reason: result.reason || 'unknown' };
  } catch (error) {
    await userRef.set({
      welcomeEmailError: error.message,
      welcomeEmailLockAt: admin.firestore.FieldValue.delete(),
    }, { merge: true });

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

const sendNewMessagePushNotification = async ({
  receiverId,
  senderId,
  chatId,
  messageId,
  messageType,
  content,
}) => {
  if (!receiverId) return false;

  try {
    const receiverDoc = await db.collection('users').doc(receiverId).get();
    if (!receiverDoc.exists) {
      return false;
    }

    const receiverData = receiverDoc.data() || {};
    const fcmToken = receiverData.fcmToken;
    if (!fcmToken) {
      return false;
    }

    await admin.messaging().send({
      notification: {
        title: 'New Message',
        body: messageType === 'text' ? String(content || '') : `Sent a ${messageType || 'message'}`,
      },
      data: {
        type: 'new_message',
        chatId: String(chatId || ''),
        messageId: String(messageId || ''),
        senderId: String(senderId || ''),
      },
      token: fcmToken,
    });

    return true;
  } catch (error) {
    console.warn('Failed to send push notification:', error.message);
    return false;
  }
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

// ==================== WEB APP VERIFICATION ====================

/**
 * Verify if user account exists in Firestore
 * Used by web app to check if Google-signed user has created account via mobile
 */
app.get('/api/verify-account', verifyToken, async (req, res) => {
  try {
    const userId = req.user.uid;
    const email = req.user.email;

    console.log(`\n🔍 ===== ACCOUNT VERIFICATION REQUEST =====`);
    console.log(`   User ID (UID): ${userId}`);
    console.log(`   Email: ${email}`);
    console.log(`   Looking in Firestore: users/${userId}`);

    // Check if user exists in Firestore
    const userDoc = await db.collection('users').doc(userId).get();

    console.log(`   Document exists: ${userDoc.exists}`);

    if (!userDoc.exists) {
      console.log(`❌ Account not found for user: ${userId}`);
      console.log(`   Tip: Check if document exists at: Firestore > users > ${userId}`);
      console.log(`========================================\n`);
      return res.json({
        exists: false,
        message: `Account not found. Please create an account using the mobile app.\n\nUser ID: ${userId}\nEmail: ${email}`
      });
    }

    const userData = userDoc.data();
    console.log(`   User data found:`, JSON.stringify(userData, null, 2));

    // Fire-and-forget welcome email for first-time backend-verified users.
    maybeSendWelcomeEmailForUser({
      userId,
      fallbackEmail: email,
    }).then((result) => {
      if (result.status === 'sent') {
        console.log(`📧 Welcome email sent to ${email} for ${userId}`);
      } else if (result.status === 'failed') {
        console.warn(`⚠️ Welcome email failed for ${userId}: ${result.reason}`);
      }
    }).catch((e) => {
      console.warn(`⚠️ Welcome email pipeline error for ${userId}: ${e.message}`);
    });

    // Verify email matches (optional additional check)
    if (userData.email && userData.email !== email) {
      console.log(`⚠️  Email mismatch for user: ${userId}`);
      console.log(`   Firestore email: ${userData.email}`);
      console.log(`   Google email: ${email}`);
      console.log(`========================================\n`);
      return res.json({
        exists: false,
        message: `Email mismatch.\n\nFirestore: ${userData.email}\nGoogle: ${email}\n\nPlease use the correct Google account.`
      });
    }

    console.log(`✅ Account verified successfully for user: ${userId}`);
    console.log(`========================================\n`);
    
    res.json({
      exists: true,
      user: {
        id: userId,
        email: email,
        name: userData.name || userData.displayName,
        photoURL: userData.photoURL,
        gender: userData.gender,
        createdAt: userData.createdAt
      }
    });

  } catch (error) {
    console.error('❌ Error verifying account:', error);
    console.error('   Error details:', error.message);
    console.error('   Stack trace:', error.stack);
    console.log(`========================================\n`);
    res.status(500).json({
      exists: false,
      error: 'Internal server error',
      message: `Failed to verify account: ${error.message}`
    });
  }
});

// ==================== USER ROUTES ====================

// Get user profile
app.get('/api/users/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const requestingUserId = req.user.uid;

    console.log(`\n📋 ===== GET USER PROFILE =====`);
    console.log(`   Requesting user: ${requestingUserId}`);
    console.log(`   Target user: ${userId}`);

    // Validate userId format
    if (!userId || userId.length === 0) {
      return res.status(400).json({ 
        success: false,
        error: 'Invalid user ID',
        message: 'User ID cannot be empty'
      });
    }

    // Verify Firestore is initialized
    if (!db) {
      console.error('❌ Firestore not initialized');
      return res.status(500).json({
        success: false,
        error: 'Database initialization failed',
        message: 'Firestore database not initialized. Check Firebase Admin SDK setup.'
      });
    }

    console.log(`🔍 Querying Firestore: users/${userId}`);
    
    // Get user from Firestore with error handling
    let userDoc;
    try {
      userDoc = await db.collection('users').doc(userId).get();
    } catch (firestoreError) {
      console.error('❌ Firestore query failed:', firestoreError.message);
      console.error('   Error code:', firestoreError.code);
      
      // Provide detailed error response
      if (firestoreError.code === 'UNAUTHENTICATED') {
        return res.status(500).json({
          success: false,
          error: 'Firestore authentication failed',
          message: 'Admin SDK cannot authenticate with Firestore. Check serviceAccountKey.json and IAM permissions.',
          details: {
            code: firestoreError.code,
            suggestion: 'Verify that: 1) Firestore API is enabled in Google Cloud Console, 2) Service account has Editor role, 3) Project ID matches in serviceAccountKey.json'
          }
        });
      } else if (firestoreError.code === 'PERMISSION_DENIED') {
        return res.status(403).json({
          success: false,
          error: 'Permission denied',
          message: 'Service account lacks permission to read this collection.',
          details: {
            code: firestoreError.code,
            suggestion: 'Ensure service account has "Editor" or "Cloud Datastore Owner" role in Firebase Console.'
          }
        });
      }
      
      throw firestoreError; // Re-throw for generic error handler
    }

    if (!userDoc.exists) {
      console.log(`⚠️  User document not found: ${userId}`);
      return res.status(404).json({ 
        success: false,
        error: 'User not found',
        message: `User profile not found for ID: ${userId}`
      });
    }

    const userData = userDoc.data();
    console.log(`✅ User found: ${userData.displayName || 'Unknown'}`);

    res.json({
      success: true,
      data: {
        id: userDoc.id,
        ...userData
      }
    });
  } catch (error) {
    console.error('❌ Error in GET /api/users/:userId:', error.message);
    console.error('   Full error:', error);
    
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error.message,
      code: error.code || 'UNKNOWN'
    });
  }
});

// Update user profile
app.put('/api/users/:userId', verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const updates = req.body;
    const requestingUserId = req.user.uid;

    console.log(`\n✏️  ===== UPDATE USER PROFILE =====`);
    console.log(`   Requesting user: ${requestingUserId}`);
    console.log(`   Target user: ${userId}`);
    console.log(`   Fields to update:`, Object.keys(updates));

    // Verify user is updating their own profile
    if (requestingUserId !== userId) {
      console.log(`⚠️  Authorization check failed: ${requestingUserId} != ${userId}`);
      return res.status(403).json({ 
        success: false,
        error: 'Unauthorized',
        message: 'You can only update your own profile'
      });
    }

    // Validate updates object
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'No fields provided for update'
      });
    }

    // Prevent updating sensitive fields
    const protectedFields = ['uid', 'createdAt', 'id'];
    const fieldsToUpdate = { ...updates };
    protectedFields.forEach(field => delete fieldsToUpdate[field]);

    console.log(`✏️  Writing to Firestore: users/${userId}`);

    try {
      await db.collection('users').doc(userId).update({
        ...fieldsToUpdate,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    } catch (firestoreError) {
      console.error('❌ Firestore update failed:', firestoreError.message);
      console.error('   Error code:', firestoreError.code);
      
      if (firestoreError.code === 'NOT_FOUND') {
        return res.status(404).json({
          success: false,
          error: 'User not found',
          message: `User profile does not exist for ID: ${userId}`
        });
      } else if (firestoreError.code === 'UNAUTHENTICATED') {
        return res.status(500).json({
          success: false,
          error: 'Firestore authentication failed',
          message: 'Admin SDK cannot authenticate with Firestore.',
          details: { code: firestoreError.code }
        });
      }
      
      throw firestoreError;
    }

    console.log(`✅ User profile updated successfully`);

    const welcomeResult = await maybeSendWelcomeEmailForUser({
      userId,
      fallbackEmail: req.user.email || '',
    });

    res.json({
      success: true,
      message: 'User profile updated successfully',
      welcomeEmail: welcomeResult,
    });
  } catch (error) {
    console.error('❌ Error in PUT /api/users/:userId:', error.message);
    
    res.status(500).json({ 
      success: false,
      error: 'Internal server error',
      message: error.message,
      code: error.code || 'UNKNOWN'
    });
  }
});

// ==================== NOTIFICATION ROUTES ====================

// Send push notification
app.post('/api/notifications/send', verifyToken, async (req, res) => {
  try {
    const { token, title, body, data } = req.body;

    if (!token || !title || !body) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const message = {
      notification: {
        title,
        body
      },
      data: data || {},
      token
    };

    const response = await admin.messaging().send(message);

    res.json({
      success: true,
      messageId: response
    });
  } catch (error) {
    console.error('Error sending notification:', error);
    res.status(500).json({ error: 'Failed to send notification' });
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
      await sendNewMessagePushNotification({
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
    // Check if user is admin
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) {
      return res.status(403).json({ error: 'Unauthorized - Admin only' });
    }

    const usersSnapshot = await db.collection('users').limit(100).get();
    const users = [];

    usersSnapshot.forEach(doc => {
      users.push({
        id: doc.id,
        ...doc.data()
      });
    });

    res.json({
      success: true,
      data: users,
      count: users.length
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

    // Check if user is admin
    const userDoc = await db.collection('users').doc(req.user.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) {
      return res.status(403).json({ error: 'Unauthorized - Admin only' });
    }

    // Delete from Firebase Auth
    await auth.deleteUser(userId);

    // Delete from Firestore
    await db.collection('users').doc(userId).delete();

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

// ==================== ANALYTICS ROUTES ====================

// Log analytics event
app.post('/api/analytics/log', verifyToken, async (req, res) => {
  try {
    const { event, properties } = req.body;

    await db.collection('analytics').add({
      userId: req.user.uid,
      event,
      properties: properties || {},
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      message: 'Event logged successfully'
    });
  } catch (error) {
    console.error('Error logging analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
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
      const { messageId, chatId, receiverId, content, mediaUrl, messageType, timestamp } = data;

      // Deliver to receiver if online
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
        });
        // Notify sender of delivery
        socket.emit('message_status_update', { messageId, status: 'delivered' });
        console.log(`📤 [Socket.IO] Message ${messageId} delivered to online user ${receiverId}`);
      } else {
        // Receiver is offline – store in MongoDB
        try {
          const exists = await PendingMessage.findOne({ messageId });
          if (!exists) {
            const encryptedPayload = encryptMessageContent(content);

            await new PendingMessage({
              messageId,
              senderId: userId,
              receiverId,
              chatId,
              messageType: messageType || 'text',
              content: encryptedPayload.content,
              mediaUrl,
              status: 'pending',
              metadata: {
                enc: encryptedPayload.enc,
              },
            }).save();
          }

          // Receiver is offline in-app: trigger push notification so user sees it
          // even when app socket is disconnected.
          await sendNewMessagePushNotification({
            receiverId,
            senderId: userId,
            chatId,
            messageId,
            messageType: messageType || 'text',
            content,
          });

          socket.emit('message_status_update', { messageId, status: 'pending' });
          console.log(`📦 [Socket.IO] Message ${messageId} queued for offline user ${receiverId}`);
        } catch (dbErr) {
          console.error('[Socket.IO] DB error queuing message:', dbErr.message);
        }
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

  // ── disconnect ──────────────────────────────────────────────
  socket.on('disconnect', () => {
    const sockets = onlineUsers.get(userId);
    if (sockets) {
      sockets.delete(socket.id);
      if (sockets.size === 0) {
        onlineUsers.delete(userId);
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

  let gender = clientProvidedGender;

  // Since Firebase Admin SDK is throwing 16 UNAUTHENTICATED issues, we must strictly rely on the client providing gender.
  if (!gender) {
    socket.emit('video_match_error', { 
      error: 'Client failed to send gender data. Please ensure you are using the latest version of the app.' 
    });
    console.error(`❌ [VideoMatch] Client did not provide gender and Firestore fallback is disabled. User: ${userId}`);
    return;
  }

  gender = gender?.toLowerCase().trim();

  if (!gender || (gender !== 'male' && gender !== 'female')) {
    socket.emit('video_match_error', {
      error: 'Gender not set in profile. Please update your profile.'
    });
    console.error(`❌ [VideoMatch] Invalid gender for user ${userId}: ${gender}`);
    return;
  }

  console.log(`🎥 [VideoMatch] ${userId} (${gender}) looking for match...`);

  const userInfo = { userId, gender, socketId: socket.id };

  // Determine which queues to use for matching
  let myQueue;
  let oppositeQueue;
  if (gender === 'male') {
    myQueue = maleQueue;
    oppositeQueue = femaleQueue;
  } else {
    myQueue = femaleQueue;
    oppositeQueue = maleQueue;
  }

  const partner = findNextValidPartner(oppositeQueue, socket.id);

  if (partner) {
    // Create pair
    videoCallPairs.set(socket.id, partner.partnerSocketId);
    videoCallPairs.set(partner.partnerSocketId, socket.id);

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

    console.log(`✅ [VideoMatch] Matched ${userId} with ${partner.partnerInfo.userId}`);
  } else {
    // No match available, add to queue
    myQueue.set(socket.id, userInfo);
    socket.emit('video_match_waiting', {
      message: 'Searching for a match...',
      queuePosition: myQueue.size
    });
    console.log(`⏳ [VideoMatch] ${userId} added to ${gender} queue (${myQueue.size} waiting)`);
  }
};

io.on('connection', (socket) => {
  
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
        try { parsedData = JSON.parse(parsedData); } catch(e) {}
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
        try { parsedData = JSON.parse(parsedData); } catch(e) {}
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
  
});

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
