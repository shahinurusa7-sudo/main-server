# MongoDB Connection Troubleshooting Guide

## Problem
Server shows error:
```
❌ MongoDB connection error: Server selection timed out after 15000 ms
⚠️  Server running without MongoDB. Message queue features disabled.
```

## Root Cause
The server cannot establish a connection to the DigitalOcean MongoDB cluster. This is typically due to:
1. **IP Whitelist** - Your server's IP isn't whitelisted in MongoDB cluster settings
2. **Network Firewall** - Port 27017 is blocked by a firewall
3. **Network Connectivity** - Your server cannot reach the MongoDB domain
4. **Timeout Too Short** - Connection takes longer than expected
5. **Cluster Down** - MongoDB cluster is experiencing issues

## Improvements Made

### Code Changes (index.js)
✅ **Increased timeout** from 15 seconds to 30 seconds  
✅ **Added retry logic** - Attempts connection 3 times with exponential backoff (5s, 10s, 15s)  
✅ **Better error diagnostics** - Logs hints for troubleshooting  
✅ **Connection pooling** - Configured for better connection management  
✅ **IPv4 enforcement** - Uses IPv4 to avoid DNS resolution issues  

New connection attempts:
- Attempt 1: Immediate
- Attempt 2: After 5 seconds (if needed)
- Attempt 3: After 10 seconds (if needed)

## How to Test Connection

### Quick Test
```bash
node test-mongodb.js
```

This diagnostic script will:
1. ✅ Parse your MongoDB connection string
2. ✅ Test DNS resolution
3. ✅ Attempt actual connection
4. ✅ Provide specific troubleshooting hints

## Troubleshooting Steps

### Step 1: Verify MongoDB URI in .env
```bash
# Check file: julieet-server/.env
# Look for: MONGODB_URI=mongodb+srv://username:password@cluster...

# Ensure:
- Username and password are correct
- No special characters in password (or URL-encoded if needed)
- Cluster hostname matches your DigitalOcean/Atlas dashboard
```

### Step 2: Whitelist Server IP in MongoDB

**DigitalOcean MongoDB:**
1. Go to your DigitalOcean Console
2. Find your Database cluster
3. Go to Settings → Trust Authentication
4. Add your server's **IP address** to the allowlist:
   - For cloud servers: Use the server's public/private IP
   - For local: Use your machine's public IP
   - For development: You can use `0.0.0.0/0` temporarily (NOT for production)

**MongoDB Atlas:**
1. Go to Network Access (Security section)
2. Click "Add IP Address"
3. Enter:
   - Specific: Your server's IP
   - OR: Allow all (0.0.0.0/0) temporarily for testing

### Step 3: Test Network Connectivity

From your server, test if you can reach MongoDB:
```bash
# Test DNS resolution
nslookup dbaas-db-8716287-669712ac.mongo.ondigitalocean.com

# Test port connectivity (using curl or telnet)
curl -v https://dbaas-db-8716287-669712ac.mongo.ondigitalocean.com:27017/
```

### Step 4: Verify Credentials

The .env shows this configuration:
```
Username: doadmin
Password: i2CBd0796f54y3Zh
Cluster: dbaas-db-8716287-669712ac.mongo.ondigitalocean.com
```

**Confirm these match your DigitalOcean dashboard:**
1. Go to DigitalOcean Console
2. Select your MongoDB cluster
3. Check "Connection Details" tab
4. Verify username and password match

### Step 5: Check MongoDB Cluster Status

1. **DigitalOcean Console**: Check cluster is "Running" (not degraded)
2. **Recent changes**: Verify no recent maintenance or updates
3. **Cluster size**: Ensure cluster has available resources

## What Happens When MongoDB Fails

**Current Behavior (Good):**
- Server continues to run ✅
- HTTP API works normally ✅
- Chat/real-time features work (Firebase) ✅
- Message queue features DISABLED ⚠️
- SMS/message delivery queue unavailable ⚠️

**When MongoDB Connects:**
- ✅ Message queue enabled
- ✅ Pending message storage active
- ✅ Automatic cleanup of old messages

## Configuration Options

If you need to temporarily disable MongoDB connection attempts:

**Option 1: Use Local MongoDB**
```bash
# In .env:
MONGODB_URI=mongodb://localhost:27017/lovebirds
```

**Option 2: Use MongoDB Atlas Community (Free)**
```bash
# Sign up at: https://www.mongodb.com/cloud/atlas
# Create cluster → Get connection string → Update MONGODB_URI in .env
```

**Option 3: Increase Timeout Further**
Edit index.js, line ~543:
```javascript
await mongoose.connect(mongoUri, {
  serverSelectionTimeoutMS: 60000,  // 60 seconds instead of 30
  // ... rest of options
});
```

## Logs to Look For

**Success Indicator:**
```
🔄 MongoDB connection attempt 1/3...
✅ MongoDB connected successfully
📦 Temporary SMS/message storage active in MongoDB
```

**Failure Indicators:**
```
❌ MongoDB connection attempt 1 failed: Server selection timed out
⏳ Retrying in 5 seconds...
```

After retries exhaust:
```
⚠️  Could not establish MongoDB connection after several attempts.
💡 Troubleshooting tips:
   1. Verify the MongoDB URI in .env is correct
   2. Check that your server IP is whitelisted in MongoDB Atlas/DigitalOcean
   3. Ensure network connectivity to the MongoDB cluster
   4. Check MongoDB cluster status at your provider dashboard
⚠️  Server running without MongoDB. Message queue features disabled.
```

## Still Having Issues?

1. **Run the diagnostic script**: `node test-mongodb.js`
2. **Check DigitalOcean logs**: See if cluster shows any errors
3. **Verify credentials**: Copy them directly from DigitalOcean, don't guess
4. **Check firewall**: Some corporate networks block port 27017
5. **Try from local machine**: Test connection from your computer to confirm credentials work
6. **Enable MongoDB debug logs**:
   ```bash
   DEBUG=mongoose:* node index.js
   ```

## Next Steps Once Fixed

Once MongoDB connection succeeds:
- ✅ Message queue features enabled
- ✅ SMS delivery queuing works
- ✅ Pending message retry system active
- ✅ Server performance optimized for high throughput

The server will continue working fine without MongoDB, but message reliability features will be unavailable.
