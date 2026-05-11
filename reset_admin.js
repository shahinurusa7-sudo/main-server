require('dotenv').config();
const mongoose = require('mongoose');
const path = require('path');
const Admin = require(path.join(__dirname, './models/Admin'));

async function resetAdmin() {
  try {
    const uri = process.env.MONGODB_URI;
    console.log('Connecting to MongoDB...');
    await mongoose.connect(uri);
    
    const email = 'indxadmincherry@julieet.com';
    const newPass = 'SC18232005@:)(:&^%';
    
    let admin = await Admin.findOne({ email });
    if (!admin) {
      console.log('Admin not found, creating...');
      admin = new Admin({ email, role: 'super_admin', isActive: true });
    }
    
    admin.password = newPass;
    await admin.save();
    
    console.log('✅ Admin password reset successfully!');
    console.log('Email:', email);
    console.log('New Password:', newPass);
    
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

resetAdmin();
