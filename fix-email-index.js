#!/usr/bin/env node
const mongoose = require('mongoose');
require('dotenv').config();

const User = require('./models/User');

async function fixEmailIndex() {
  try {
    console.log('🔧 Connecting to MongoDB...');
    const mongoUri = process.env.MONGODB_URI || 'mongodb+srv://doadmin:8R67T5uh2V9M13dj@dbaas-db-8716287-669712ac.mongo.ondigitalocean.com/admin?tls=true&authSource=admin&replicaSet=dbaas-db-8716287';
    await mongoose.connect(mongoUri, {
      serverSelectionTimeoutMS: 30000,
      socketTimeoutMS: 45000,
      family: 4,
      retryWrites: true,
      maxPoolSize: 10,
    });
    console.log('✅ Connected');

    // Step 1: Drop ALL indexes to allow cleanup
    console.log('💥 Dropping all indexes...');
    try {
      await User.collection.dropIndexes();
      console.log('✅ All indexes dropped');
    } catch (err) {
      console.warn('⚠️  Could not drop indexes:', err.message);
    }

    // Step 2: Delete documents with null/invalid uids (these are corrupted)
    console.log('🗑️  Removing invalid documents (uid: null/empty)...');
    const invalidResult = await User.collection.deleteMany({
      $or: [
        { uid: null },
        { uid: undefined },
        { uid: '' },
        { uid: { $exists: false } }
      ]
    });
    console.log(`✅ Deleted ${invalidResult.deletedCount} invalid documents`);

    // Step 3: Convert empty emails to null
    console.log('🧹 Converting empty emails to null...');
    const updateResult = await User.collection.updateMany(
      { email: '' },
      { $set: { email: null } }
    );
    console.log(`✅ Updated ${updateResult.modifiedCount} documents`);

    // Step 4: Remove duplicate null emails (keep only one per uid)
    console.log('🔍 Checking for duplicate null emails...');
    const duplicateNullEmails = await User.collection.aggregate([
      { $match: { email: null } },
      { $group: { _id: null, count: { $sum: 1 }, ids: { $push: '$_id' } } }
    ]).toArray();

    if (duplicateNullEmails.length > 0 && duplicateNullEmails[0].count > 1) {
      console.log(`⚠️  Found ${duplicateNullEmails[0].count} documents with null email`);
      // Keep the first one, delete the rest
      const idsToDelete = duplicateNullEmails[0].ids.slice(1);
      const deleteResult = await User.collection.deleteMany({
        _id: { $in: idsToDelete }
      });
      console.log(`✅ Deleted ${deleteResult.deletedCount} duplicate null email documents`);
    }

    // Step 5: Recreate indexes from schema
    console.log('📝 Recreating indexes from schema...');
    await User.syncIndexes();
    console.log('✅ Indexes synced and recreated');

    console.log('\n✅ Email index fix complete!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

fixEmailIndex();
