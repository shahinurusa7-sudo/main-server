require('dotenv').config();
const express = require('express');
const http = require('http');
const mongoose = require('mongoose');
const cors = require('cors');
const nodemailer = require('nodemailer');
const socketIo = require('socket.io');
const jwt = require('jsonwebtoken');

// Models
const Admin = require('./models/Admin');
const User = require('./models/User');
const Match = require('./models/Match');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.ADMIN_PORT || 3005;
const JWT_SECRET = process.env.JWT_SECRET || 'julieet-admin-secret-key-9988-shahinur';
const SUPER_ADMIN_EMAIL = 'shahinuralam@julieet.com';

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('Admin Server: Connected to MongoDB'))
  .catch(err => console.error('Admin Server: MongoDB connection error:', err));

// Email Transporter
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// Middleware: Authenticate Admin
const authenticateAdmin = async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ message: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const admin = await Admin.findById(decoded.id);
    if (!admin || !admin.isActive) return res.status(403).json({ message: 'Unauthorized or account disabled' });
    req.admin = admin;
    next();
  } catch (err) {
    res.status(401).json({ message: 'Invalid token' });
  }
};

// Middleware: Super Admin only
const superAdminOnly = (req, res, next) => {
  if (req.admin.role !== 'super_admin' && req.admin.email !== SUPER_ADMIN_EMAIL) {
    return res.status(403).json({ message: 'Super Admin privileges required' });
  }
  next();
};

// --- AUTH ROUTES ---

// Request OTP
app.post('/api/admin/auth/request-otp', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ message: 'Email is required' });

  // Only allow @julieet.com
  if (!email.endsWith('@julieet.com')) {
    return res.status(403).json({ message: 'Only @julieet.com emails are permitted' });
  }

  try {
    let admin = await Admin.findOne({ email });
    
    // NEW RULE: If not registered and not the hardcoded Super Admin, REJECT
    if (!admin && email !== SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ message: 'Access denied. You must be registered by a Super Admin first.' });
    }

    // If super admin and doesn't exist, create initial record
    if (!admin && email === SUPER_ADMIN_EMAIL) {
      admin = new Admin({ email, role: 'super_admin' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    admin.otp = otp;
    admin.otpExpires = new Date(Date.now() + 10 * 60 * 1000); 
    await admin.save();

    // Send Email
    await transporter.sendMail({
      from: `"${process.env.SMTP_FROM_NAME}" <${process.env.SMTP_FROM_EMAIL}>`,
      to: email,
      subject: 'Julieet Admin Panel OTP',
      html: `
        <div style="font-family: sans-serif; padding: 40px; background: #0f0c29; color: white; border-radius: 20px; text-align: center;">
          <h1 style="color: #ff4d6d; font-size: 32px;">Julieet Admin Security</h1>
          <p style="font-size: 18px; color: #a0aec0;">Your secure one-time password for the Admin Panel is:</p>
          <div style="background: rgba(255,255,255,0.1); padding: 20px; border-radius: 15px; margin: 30px auto; width: fit-content;">
            <h1 style="letter-spacing: 10px; font-size: 48px; margin: 0; color: #fff;">${otp}</h1>
          </div>
          <p style="color: #ff4d6d; font-weight: bold;">Expires in 10 minutes.</p>
          <hr style="border: 0; border-top: 1px solid rgba(255,255,255,0.1); margin: 30px 0;">
          <p style="font-size: 12px; color: #718096;">If you did not request this, please contact the Super Admin immediately.</p>
        </div>
      `,
    });

    res.json({ message: 'OTP sent to your email' });
  } catch (err) {
    console.error('OTP Error:', err);
    res.status(500).json({ message: 'Error processing request' });
  }
});

// Verify OTP
app.post('/api/admin/auth/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const admin = await Admin.findOne({ email, otp, otpExpires: { $gt: new Date() } });
    if (!admin) return res.status(401).json({ message: 'Invalid or expired OTP' });

    admin.otp = null;
    admin.otpExpires = null;
    admin.lastLogin = new Date();
    await admin.save();

    const token = jwt.sign({ id: admin._id, role: admin.role }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, admin: { email: admin.email, role: admin.role } });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// --- ADMIN MANAGEMENT (Super Admin Only) ---

app.get('/api/admin/list', authenticateAdmin, superAdminOnly, async (req, res) => {
  try {
    const admins = await Admin.find({ email: { $ne: SUPER_ADMIN_EMAIL } }).select('-otp -otpExpires');
    res.json(admins);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching admins' });
  }
});

app.post('/api/admin/add', authenticateAdmin, superAdminOnly, async (req, res) => {
  const { email, role } = req.body;
  if (!email || !email.endsWith('@julieet.com')) {
    return res.status(400).json({ message: 'Valid @julieet.com email is required' });
  }

  try {
    const existing = await Admin.findOne({ email });
    if (existing) return res.status(400).json({ message: 'Admin already exists' });

    const newAdmin = new Admin({ email, role: role || 'admin' });
    await newAdmin.save();
    res.json({ message: 'Admin added successfully. They can now request OTP to login.' });
  } catch (err) {
    res.status(500).json({ message: 'Error adding admin' });
  }
});

app.delete('/api/admin/:id', authenticateAdmin, superAdminOnly, async (req, res) => {
  try {
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ message: 'Admin removed successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Error removing admin' });
  }
});

// --- USER MANAGEMENT ---

app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 20, search = '' } = req.query;
    const query = search ? { 
      $or: [
        { email: { $regex: search, $options: 'i' } },
        { displayName: { $regex: search, $options: 'i' } },
        { uid: search }
      ] 
    } : {};

    // Do NOT include messages in the query (Messages are in a different collection usually)
    const users = await User.find(query)
      .limit(limit * 1)
      .skip((page - 1) * limit)
      .sort({ createdAt: -1 });

    const count = await User.countDocuments(query);
    res.json({ users, totalPages: Math.ceil(count / limit), totalUsers: count });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching users' });
  }
});

app.post('/api/admin/users/:uid/toggle-ban', authenticateAdmin, async (req, res) => {
  try {
    const user = await User.findOne({ uid: req.params.uid });
    if (!user) return res.status(404).json({ message: 'User not found' });

    // Assuming we use 'isActive' or 'isBanned' field. Let's use 'isBanned'
    user.isBanned = !user.isBanned;
    await user.save();

    res.json({ message: `User ${user.isBanned ? 'banned' : 'unbanned'} successfully`, isBanned: user.isBanned });
  } catch (err) {
    res.status(500).json({ message: 'Error updating user status' });
  }
});

// Stats
app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
  try {
    const [total, males, females, matches, active] = await Promise.all([
      User.countDocuments(),
      User.countDocuments({ gender: 'male' }),
      User.countDocuments({ gender: 'female' }),
      Match.countDocuments(),
      User.countDocuments({ online: true })
    ]);
    res.json({ totalUsers: total, maleUsers: males, femaleUsers: females, totalMatches: matches, activeUsers: active });
  } catch (err) {
    res.status(500).json({ message: 'Error fetching stats' });
  }
});

// --- WEBSOCKETS ---
io.on('connection', (socket) => {
  const statsInterval = setInterval(async () => {
    try {
      const activeUsers = await User.countDocuments({ online: true });
      socket.emit('live_stats', { activeUsers });
    } catch (err) {}
  }, 5000);
  socket.on('disconnect', () => clearInterval(statsInterval));
});

server.listen(PORT, () => console.log(`Julieet Admin Server running on port ${PORT}`));
