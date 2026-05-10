/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║           JULIEET PUSH NOTIFICATION MODULE                  ║
 * ║  Production-grade FCM notifications via MongoDB + Firebase  ║
 * ║  ✅ NO Firestore required — uses MongoDB exclusively        ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Usage:
 *   const push = require('./push notification');
 *   push.init(admin, User);   // call once at startup
 *
 *   await push.toUser(userId, { title, body, data });
 *   await push.newMessage({ receiverId, senderId, chatId, messageId, messageType, content });
 *   await push.newLike({ toUserId, fromUserId, fromUserName, fromUserPhoto });
 *   await push.newMatch({ userId1, userId2, userName1, userName2, matchId });
 */

'use strict';

// ─── Module-level references (set by init()) ─────────────────────────────────
let _admin = null;
let _User  = null;

/**
 * Initialise the module. Must be called once before any other function.
 * @param {object} adminSdk  - Initialized firebase-admin instance
 * @param {object} UserModel - Mongoose User model
 */
function init(adminSdk, UserModel) {
  _admin = adminSdk;
  _User  = UserModel;
  console.log('✅ [Push] Notification module initialized (MongoDB-only, no Firestore)');
}

// ─── Token collection (reads from MongoDB only) ───────────────────────────────

/**
 * Collect all valid FCM tokens for a user from MongoDB.
 * Supports both:
 *   - fcmToken  : String  (single device)
 *   - fcmTokens : { token: true }  (multi-device map)
 *
 * @param {string} userId
 * @returns {Promise<string[]>}
 */
async function _getTokens(userId) {
  if (!_User) throw new Error('[Push] Module not initialized. Call push.init(admin, User) first.');

  const doc = await _User.findOne({ uid: userId }).select('fcmToken fcmTokens').lean();
  if (!doc) return [];

  const set = new Set();

  if (typeof doc.fcmToken === 'string' && doc.fcmToken.trim().length > 0) {
    set.add(doc.fcmToken.trim());
  }

  if (doc.fcmTokens && typeof doc.fcmTokens === 'object' && !Array.isArray(doc.fcmTokens)) {
    for (const [token, enabled] of Object.entries(doc.fcmTokens)) {
      if (typeof token === 'string' && token.trim().length > 0 && enabled === true) {
        set.add(token.trim());
      }
    }
  }

  return Array.from(set);
}

/**
 * Remove a stale / invalid token from MongoDB so we stop wasting FCM quota.
 * @param {string} userId
 * @param {string} token
 */
async function _pruneToken(userId, token) {
  try {
    // Build the $unset object to remove both the single token field
    // (if it matches) and the multi-device map entry.
    const unsetFields = { [`fcmTokens.${token}`]: '' };
    const doc = await _User.findOne({ uid: userId }).select('fcmToken').lean();
    if (doc && doc.fcmToken === token) {
      unsetFields.fcmToken = '';
    }
    await _User.updateOne({ uid: userId }, { $unset: unsetFields });
    console.log(`🗑️  [Push] Pruned stale token for user ${userId}`);
  } catch (e) {
    console.warn(`⚠️  [Push] Could not prune token: ${e.message}`);
  }
}

// ─── FCM payload builder ──────────────────────────────────────────────────────

/**
 * Build a high-priority FCM message object for a single token.
 *
 * @param {string} token
 * @param {string} title
 * @param {string} body
 * @param {object} data         - Key/value pairs (all values are auto-stringified)
 * @param {'messages'|'matches'} channelId - Android notification channel
 * @returns {object}            - FCM message payload
 */
function _buildPayload(token, title, body, data = {}, channelId = 'messages') {
  // FCM requires all data values to be strings
  const stringData = {};
  for (const [k, v] of Object.entries(data)) {
    stringData[k] = String(v ?? '');
  }

  return {
    token,
    notification: { title: String(title), body: String(body) },
    data: stringData,

    // ── Android: wake device even in Doze / background ──────────────
    android: {
      priority: 'high',
      notification: {
        channelId,
        priority: 'high',
        defaultSound: true,
        defaultVibrateTimings: true,
        notificationCount: 1,
        color: '#E92163',
        icon: '@mipmap/ic_launcher',
        tag: data.chatId || data.fromUserId || undefined, // group by chat/user
      },
    },

    // ── iOS: maximum APNs priority ───────────────────────────────────
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
          alert: { title: String(title), body: String(body) },
          threadId: data.chatId || data.matchId || data.fromUserId || undefined,
        },
      },
    },
  };
}

// ─── Core send function ───────────────────────────────────────────────────────

/**
 * Send a push notification to a user (by userId).
 * Automatically collects tokens from MongoDB.
 * Prunes stale tokens if FCM rejects them.
 *
 * @param {string} userId
 * @param {{ title: string, body: string, data?: object, channelId?: string }} opts
 * @returns {Promise<boolean>}  true if at least one token was delivered
 */
async function toUser(userId, { title, body, data = {}, channelId } = {}) {
  if (!userId) return false;
  if (!_admin) throw new Error('[Push] Module not initialized. Call push.init(admin, User) first.');

  try {
    const tokens = await _getTokens(userId);

    if (tokens.length === 0) {
      console.warn(`⚠️  [Push] No FCM tokens for user ${userId}`);
      return false;
    }

    // Determine channel from data.type if not explicitly provided
    const type = String(data.type || '');
    const resolvedChannel = channelId ||
      (type === 'like' || type === 'match' ? 'matches' : 'messages');

    let sent = 0;
    for (const token of tokens.slice(0, 5)) {  // cap at 5 devices per user
      try {
        const payload = _buildPayload(token, title, body, data, resolvedChannel);
        await _admin.messaging().send(payload);
        sent++;
        console.log(`✅ [Push] Delivered "${type || 'notification'}" to ${userId} (token …${token.slice(-8)})`);
      } catch (err) {
        const code = err.code || '';
        if (
          code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token' ||
          code === 'messaging/invalid-argument'
        ) {
          await _pruneToken(userId, token);
        } else {
          console.warn(`⚠️  [Push] Send failed for ${userId}: ${err.message}`);
        }
      }
    }

    return sent > 0;
  } catch (error) {
    console.error(`❌ [Push] toUser error for ${userId}: ${error.message}`);
    return false;
  }
}

// ─── Typed notification helpers ───────────────────────────────────────────────

/**
 * Notify a user about a new chat message.
 *
 * @param {{ receiverId, senderId, chatId, messageId, messageType, content, senderName? }} opts
 */
async function newMessage({ receiverId, senderId, chatId, messageId, messageType, content, senderName }) {
  if (!receiverId) return false;

  // Resolve sender name from MongoDB if not passed in
  let name = senderName;
  if (!name && senderId && _User) {
    try {
      const sender = await _User.findOne({ uid: senderId }).select('displayName name').lean();
      name = sender?.displayName || sender?.name || null;
    } catch (_) { /* best-effort */ }
  }
  const title = name || 'New Message';

  const type = String(messageType || 'text').toLowerCase();
  const body = type === 'text'
    ? String(content || '').slice(0, 120)
    : type === 'image'  ? '📷 Sent a photo'
    : type === 'video'  ? '🎥 Sent a video'
    : type === 'audio'  ? '🎵 Sent a voice message'
    : `Sent a ${type}`;

  return toUser(receiverId, {
    title,
    body,
    channelId: 'messages',
    data: {
      type:        'new_message',
      chatId:      String(chatId  || ''),
      messageId:   String(messageId || ''),
      senderId:    String(senderId || ''),
      senderName:  title,
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      deep_link:   `/chat/${chatId}`,
    },
  });
}

/**
 * Notify a user they received a like.
 *
 * @param {{ toUserId, fromUserId, fromUserName, fromUserPhoto? }} opts
 */
async function newLike({ toUserId, fromUserId, fromUserName, fromUserPhoto }) {
  if (!toUserId) return false;

  return toUser(toUserId, {
    title: '❤️ New Like!',
    body:  `${fromUserName || 'Someone'} liked your profile.`,
    channelId: 'matches',
    data: {
      type:          'like',
      fromUserId:    String(fromUserId   || ''),
      fromUserName:  String(fromUserName || ''),
      fromUserPhoto: String(fromUserPhoto || ''),
      click_action:  'FLUTTER_NOTIFICATION_CLICK',
      deep_link:     '/likes',
    },
  });
}

/**
 * Notify BOTH users of a mutual match.
 *
 * @param {{ userId1, userId2, userName1, userName2, matchId? }} opts
 */
async function newMatch({ userId1, userId2, userName1, userName2, matchId }) {
  if (!userId1 || !userId2) return;

  const matchIdStr = String(matchId || '');

  const p1 = toUser(userId1, {
    title: "It's a Match! 💕",
    body:  `You and ${userName2 || 'someone'} liked each other! Start chatting now.`,
    channelId: 'matches',
    data: {
      type:         'match',
      matchId:      matchIdStr,
      fromUserId:   String(userId2   || ''),
      fromUserName: String(userName2 || ''),
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      deep_link:    '/matches',
    },
  });

  const p2 = toUser(userId2, {
    title: "It's a Match! 💕",
    body:  `You and ${userName1 || 'someone'} liked each other! Start chatting now.`,
    channelId: 'matches',
    data: {
      type:         'match',
      matchId:      matchIdStr,
      fromUserId:   String(userId1   || ''),
      fromUserName: String(userName1 || ''),
      click_action: 'FLUTTER_NOTIFICATION_CLICK',
      deep_link:    '/matches',
    },
  });

  await Promise.allSettled([p1, p2]);
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  init,       // init(admin, User) — call once at startup
  toUser,     // toUser(userId, { title, body, data, channelId })
  newMessage, // newMessage({ receiverId, senderId, chatId, ... })
  newLike,    // newLike({ toUserId, fromUserId, fromUserName, ... })
  newMatch,   // newMatch({ userId1, userId2, userName1, userName2, matchId })
};
