const mongoose = require('mongoose');
require('dotenv').config();

async function fix() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.');

  try {
    const collection = mongoose.connection.db.collection('likes');
    console.log('Checking indexes on "likes" collection...');
    const indexes = await collection.indexes();
    console.log('Current indexes:', indexes.map(i => i.name));

    if (indexes.find(i => i.name === 'fromId_1_toId_1')) {
      console.log('Found stale index "fromId_1_toId_1". Dropping it...');
      await collection.dropIndex('fromId_1_toId_1');
      console.log('Index dropped successfully.');
    } else {
      console.log('Stale index "fromId_1_toId_1" not found.');
    }

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

fix();
