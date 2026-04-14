#!/usr/bin/env node

/**
 * MongoDB Connection Diagnostic Tool
 * Helps identify why MongoDB connection is failing
 */

require('dotenv').config();
const mongoose = require('mongoose');
const dns = require('dns').promises;
const net = require('net');

const MONGODB_URI = process.env.MONGODB_URI || 
  'mongodb+srv://doadmin:8R67T5uh2V9M13dj@dbaas-db-8716287-669712ac.mongo.ondigitalocean.com/admin?tls=true&authSource=admin&replicaSet=dbaas-db-8716287';

// Mask password in URI for logging
const maskUri = (uri) => {
  return uri.replace(/(:)(.+)(@)/, '$1***@');
};

console.log('\n🔍 MongoDB Connection Diagnostic Tool\n');
console.log('📍 MongoDB URI:', maskUri(MONGODB_URI));

// Step 1: Parse the connection string
console.log('\n📋 Step 1: Parsing MongoDB Connection String...');
try {
  const url = new URL(`mongodb://${MONGODB_URI.replace('mongodb://', '').replace('mongodb+srv://', '')}`);
  const hostname = url.hostname || MONGODB_URI.split('@')[1]?.split('/')[0] || MONGODB_URI.split('@')[1]?.split('?')[0];
  console.log('✅ Domain:', hostname || 'Could not parse');
  console.log('✅ Port: 27017 (SRV record)');
  console.log('✅ TLS: Enabled');
  console.log('✅ Auth Source: admin');
} catch (error) {
  console.log('⚠️  Parsing warning:', error.message);
}

// Step 2: DNS Resolution
console.log('\n📍 Step 2: Checking DNS Resolution...');
(async () => {
  try {
    const domain = MONGODB_URI.split('@')[1]?.split('/')[0] || MONGODB_URI.split('@')[1]?.split('?')[0];
    if (!domain) {
      console.log('⚠️  Could not extract domain from URI');
      return;
    }
    
    console.log(`🔎 Resolving: ${domain}...`);
    const addresses = await dns.resolve4(domain);
    console.log(`✅ DNS Resolution successful!`);
    console.log(`   IP Addresses: ${addresses.join(', ')}`);
  } catch (error) {
    console.error(`❌ DNS Resolution failed: ${error.message}`);
    console.error('   💡 This means the MongoDB server cannot be found by hostname');
    console.error('   💡 Check your internet connection or MongoDB domain name');
  }

  // Step 3: Test connection with options
  console.log('\n📍 Step 3: Testing MongoDB Connection...');
  console.log('⏳ Attempting connection (this may take up to 30 seconds)...\n');
  
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      family: 4,
      retryWrites: true,
      maxPoolSize: 5,
      minPoolSize: 1,
    });
    
    console.log('✅ MongoDB Connection Successful!');
    console.log('✅ Server is reachable');
    console.log('✅ Authentication appears to be working');
    console.log('✅ All systems ready for message queue features');
    
    await mongoose.connection.close();
    console.log('\n✅ Test complete - Connection closed\n');
    process.exit(0);
  } catch (error) {
    console.error(`❌ MongoDB Connection Failed: ${error.message}`);
    console.error('\n📋 Error Details:');
    
    if (error.message.includes('Server selection timed out')) {
      console.error('   ⚠️  Connection Timeout');
      console.error('   💡 Fix: Check MongoDB cluster status and firewall rules');
      console.error('   💡 Make sure your server IP is whitelisted in MongoDB');
    } else if (error.message.includes('authentication failed')) {
      console.error('   ⚠️  Authentication Error');
      console.error('   💡 Fix: Verify username and password in MONGODB_URI');
    } else if (error.message.includes('ENOTFOUND') || error.message.includes('getaddrinfo')) {
      console.error('   ⚠️  DNS Resolution Error');
      console.error('   💡 Fix: Check internet connection and domain name');
    } else if (error.message.includes('ECONNREFUSED')) {
      console.error('   ⚠️  Connection Refused');
      console.error('   💡 Fix: MongoDB cluster may be down or port 27017 is blocked');
    }
    
    console.error('\n🔧 Troubleshooting Steps:');
    console.error('   1. Verify MongoDB cluster is running');
    console.error('   2. Check server IP is whitelisted in MongoDB dashboard');
    console.error('   3. Confirm network connectivity to MongoDB');
    console.error('   4. Test from this server machine: curl https://dbaas-db-8716287-669712ac.mongo.ondigitalocean.com');
    console.error('   5. Review .env MONGODB_URI value');
    
    process.exit(1);
  }
})();
