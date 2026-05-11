require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const Admin = require(path.join(__dirname, './models/Admin'));

async function checkAdmins() {
  try {
    const uri = process.env.MONGODB_URI;
    console.log('Connecting to MongoDB...');
    await mongoose.connect(uri);
    console.log('Connected!');

    const admins = await Admin.find({}, 'email role isActive password');
    console.log('Total Admins Found:', admins.length);
    admins.forEach(a => {
      console.log(`- ${a.email} (${a.role}) | Active: ${a.isActive} | HasPass: ${!!a.password}`);
    });

    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkAdmins();
