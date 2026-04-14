# Love Birds Server API

Backend server for Love Birds mobile application with Firebase Admin SDK integration.

## Features

- 🔥 Firebase Admin SDK integration (Firestore, Realtime Database, Auth, Storage)
- � **MongoDB Message Queue** - Offline message storage and delivery- 🎥 **WebRTC Video Matching** - Omegle-style random video calls with opposite gender matching
- 🔌 **Socket.IO Real-time** - Live messaging and video signaling- 🚀 Express.js REST API
- 🔒 JWT token authentication
- 🛡️ Security headers with Helmet
- 🚦 Rate limiting
- 📝 Request logging with Morgan
- 💾 CORS support
- ⚡ Fast and scalable

## Prerequisites

- Node.js >= 18.0.0
- npm or yarn
- Firebase project with Admin SDK enabled
- Firebase service account key
- **MongoDB** (local or MongoDB Atlas) - for message queue

## Installation

### 1. Clone and Install Dependencies

```bash
cd julieet-server
npm install
```

### 2. Get Firebase Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Select your project
3. Go to **Project Settings** (gear icon) → **Service Accounts**
4. Click **Generate New Private Key**
5. Save the JSON file as `serviceAccountKey.json` in the server root directory

### 3. Configure Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Edit `.env` file:

```env
PORT=3000
NODE_ENV=development

# Option 1: Path to service account JSON file (for local development)
FIREBASE_SERVICE_ACCOUNT_PATH=./serviceAccountKey.json

# Firebase Project Configuration
FIREBASE_DATABASE_URL=https://your-project-id.firebaseio.com
FIREBASE_STORAGE_BUCKET=your-project-id.appspot.com

# MongoDB Configuration (for message queue)
MONGODB_URI=mongodb://localhost:27017/lovebirds

# Message queue encryption key (required in production)
OFFLINE_MSG_ENCRYPTION_KEY=replace_with_a_long_random_secret

# CORS Configuration
ALLOWED_ORIGINS=*
```

**Note:** For MongoDB, you can use:
- **Local MongoDB:** `mongodb://localhost:27017/lovebirds`
- **MongoDB Atlas:** `mongodb+srv://username:password@cluster.mongodb.net/lovebirds`

## Running the Server

### Development Mode

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

The server will start on `http://localhost:3000` (or the port specified in `.env`)

## API Endpoints

### Public Endpoints

#### Health Check
```
GET /
GET /health
```

### Protected Endpoints (Require Authentication)

All protected endpoints require `Authorization: Bearer <token>` header.

#### User Management

```
GET    /api/users/:userId          # Get user profile
PUT    /api/users/:userId          # Update user profile
```

#### Chat Management

```
POST   /api/chats/create           # Create or get existing chat
```

#### Message Queue (Offline Messaging)

```
POST   /api/messages/send          # Send message (queues if receiver offline)
GET    /api/messages/pending       # Get all pending messages for user
GET    /api/messages/pending/:chatId  # Get pending messages for specific chat
POST   /api/messages/sync          # Sync all pending messages
POST   /api/messages/delivered     # Mark messages as delivered
DELETE /api/messages/cleanup       # Delete delivered messages from queue
GET    /api/messages/stats         # Get message queue statistics
```

#### Notifications

```
POST   /api/notifications/send     # Send push notification
```

#### Storage

```
POST   /api/storage/upload-url     # Get signed URL for file upload
```

#### Analytics

```
POST   /api/analytics/log          # Log analytics event
```

#### Admin Endpoints (Admin Only)

```
GET    /api/admin/users            # Get all users
DELETE /api/admin/users/:userId    # Delete user
```

## Authentication

The server uses Firebase ID tokens for authentication. Include the token in the Authorization header:

```
Authorization: Bearer <firebase_id_token>
```

### Example: Getting a User Profile

```javascript
const response = await fetch('http://localhost:3000/api/users/USER_ID', {
  headers: {
    'Authorization': 'Bearer ' + firebaseIdToken,
    'Content-Type': 'application/json'
  }
});

const data = await response.json();
```

## API Request Examples

### Send Push Notification

```bash
curl -X POST http://localhost:3000/api/notifications/send \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "token": "FCM_DEVICE_TOKEN",
    "title": "New Message",
    "body": "You have a new message!",
    "data": {
      "chatId": "chat123",
      "type": "message"
    }
  }'
```

### Create Chat

```bash
curl -X POST http://localhost:3000/api/chats/create \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "participantIds": ["user1_id", "user2_id"]
  }'
```

## Security Features

- **Helmet**: Adds security headers
- **CORS**: Configurable cross-origin resource sharing
- **Rate Limiting**: Prevents abuse (100 requests per 15 minutes)
- **JWT Verification**: All protected routes verify Firebase tokens
- **Admin Check**: Admin-only routes verify user permissions
- **Queued Message Encryption**: Offline message content is encrypted at rest (AES-256-GCM)

## Error Handling

The API returns consistent error responses:

```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

HTTP Status Codes:
- `200` - Success
- `400` - Bad Request
- `401` - Unauthorized (no token)
- `403` - Forbidden (invalid token or insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error

## Project Structure

```
julieet-server/
├── index.js              # Main server file
├── package.json          # Dependencies
├── .env                  # Environment variables (not in git)
├── .env.example          # Environment template
├── .gitignore           # Git ignore rules
├── serviceAccountKey.json # Firebase credentials (not in git)
└── README.md            # This file
```

## Environment Variables Reference

| Variable | Description | Required |
|----------|-------------|----------|
| `PORT` | Server port | No (default: 3000) |
| `NODE_ENV` | Environment (development/production) | No |
| `FIREBASE_SERVICE_ACCOUNT_PATH` | Path to service account JSON | Yes* |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Service account as JSON string | Yes* |
| `FIREBASE_DATABASE_URL` | Realtime Database URL | Yes |
| `FIREBASE_STORAGE_BUCKET` | Storage bucket name | Yes |
| `OFFLINE_MSG_ENCRYPTION_KEY` | Encryption key for queued/offline messages | Yes (production) |
| `ALLOWED_ORIGINS` | CORS allowed origins | No (default: *) |

*Either `FIREBASE_SERVICE_ACCOUNT_PATH` or `FIREBASE_SERVICE_ACCOUNT_JSON` must be provided.

## Connecting to Flutter App

In your Flutter app, configure the base URL:

```dart
class ApiService {
  static const String baseUrl = 'http://your-server-url:3000';
  
  static Future<Map<String, dynamic>> getUser(String userId) async {
    final token = await FirebaseAuth.instance.currentUser?.getIdToken();
    
    final response = await http.get(
      Uri.parse('$baseUrl/api/users/$userId'),
      headers: {
        'Authorization': 'Bearer $token',
        'Content-Type': 'application/json',
      },
    );
    
    return json.decode(response.body);
  }
}
```

## Message Queue System

The server includes a MongoDB-based message queue for offline messaging:

### How It Works

1. **User sends message** → Stored in MongoDB
2. **Receiver is offline** → Message waits in queue
3. **Receiver comes online** → Messages delivered automatically
4. **Saved to local SQLite** → Messages stored on device
5. **Cleanup** → Delivered messages removed from MongoDB

### Features

- ✅ Automatic message queuing when users are offline
- ✅ Auto-sync when users reconnect
- ✅ Message persistence on local device (SQLite)
- ✅ Automatic cleanup of delivered messages
- ✅ Message expiration (7 days)
- ✅ Retry mechanism for failed deliveries

### Flutter Integration

See **[FLUTTER_MESSAGE_QUEUE_GUIDE.md](FLUTTER_MESSAGE_QUEUE_GUIDE.md)** for complete Flutter integration guide with:
- SQLite database setup
- Message queue service implementation
- Connectivity monitoring
- Auto-sync implementation
- Complete code examples

## WebRTC Video Matching

The server includes a real-time WebRTC signaling server for Omegle-style random video matching:

### Features

- 🎥 **Opposite Gender Matching** - Males matched with females automatically
- 🔥 **Firebase Integration** - Gender fetched from user profiles (no client spoofing)
- 🚀 **Google STUN Servers** - Free NAT traversal
- ⚡ **Fast Matching** - First-in-first-out queue system
- 🔄 **Skip to Next** - Instant re-matching with new partner
- 🔌 **Socket.IO** - Real-time signaling for WebRTC

### How It Works

1. User requests video match (no gender parameter needed)
2. **Server fetches gender from Firestore** using Firebase Admin SDK
3. User added to gender-specific queue (male or female)
4. Server matches with opposite gender user
5. WebRTC connection established via Socket.IO signaling
6. Users can skip to next match instantly

### Requirements

Users must have `gender` field in Firestore profile:

```json
{
  "userId": "abc123",
  "name": "John Doe",
  "gender": "male",  // Required: "male" or "female"
  "email": "john@example.com",
  // ... other fields
}
```

### Socket.IO Events

#### Client → Server
- `video_match_start` - Start searching for match
- `video_match_cancel` - Cancel search
- `webrtc_offer` - Send WebRTC offer
- `webrtc_answer` - Send WebRTC answer
- `webrtc_ice_candidate` - Exchange ICE candidates
- `video_call_next` - Skip to next match
- `video_call_end` - End current call

#### Server → Client
- `video_match_found` - Match found with partner info
- `video_match_waiting` - Waiting in queue
- `video_match_error` - Error occurred
- `webrtc_offer` - Received offer from partner
- `webrtc_answer` - Received answer from partner
- `webrtc_ice_candidate` - Received ICE candidate
- `video_call_ended` - Call ended

### Documentation

- **[WEBRTC_VIDEO_MATCHING_GUIDE.md](WEBRTC_VIDEO_MATCHING_GUIDE.md)** - Complete API reference, Flutter implementation examples, troubleshooting
- **[QUICK_SETUP_VIDEO_MATCH.md](QUICK_SETUP_VIDEO_MATCH.md)** - Quick setup guide for getting started

### Example Usage (Flutter)

```dart
// Connect to server
final socket = IO.io('http://your-server:3002', {
  'auth': {'token': firebaseIdToken},
  'transports': ['polling', 'websocket'],
});

// Start matching (gender fetched from Firebase automatically)
socket.emit('video_match_start', {});

// Listen for match
socket.on('video_match_found', (data) {
  String partnerId = data['partnerId'];
  List iceServers = data['iceServers'];
  bool isInitiator = data['isInitiator'];
  
  // Setup WebRTC connection...
});
```

## Deployment

See [DIGITALOCEAN_DEPLOYMENT.md](DIGITALOCEAN_DEPLOYMENT.md) for detailed deployment instructions.

## Troubleshooting

### Error: Firebase service account credentials not found

- Make sure `serviceAccountKey.json` exists in the server root
- Or set `FIREBASE_SERVICE_ACCOUNT_JSON` environment variable

### Error: Cannot connect to Firebase

- Check `FIREBASE_DATABASE_URL` is correct
- Verify service account has proper permissions in Firebase Console

### Error: CORS issues

- Add your client domain to `ALLOWED_ORIGINS` in `.env`

## License

ISC
