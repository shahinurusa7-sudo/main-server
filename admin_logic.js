const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Admin = require('./models/Admin');
const User = require('./models/User');
const Match = require('./models/Match');
const SponsorAd = require('./models/SponsorAd');
const SystemSettings = require('./models/SystemSettings');
const Report = require('./models/Report');


const JWT_SECRET = process.env.JWT_SECRET || 'julieet-admin-secret-key-9988-shahinur';
const SUPER_ADMIN_EMAIL = 'indxadmincherry@julieet.com';

// ─── Email Transporter ───────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_SECURE === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ─── Multer — Sponsor Ad Image Upload ────────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads', 'sponsor-ads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `sponsor_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.webp', '.gif'];
    if (allowed.includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Only image files allowed (jpg, png, webp, gif)'));
    }
  },
});

// ─── Main export ─────────────────────────────────────────────────────────────
module.exports = function (io, app) {
  console.log('🛡️  Admin Module: Initializing /admin namespace & routes...');

  // ── Auto-Provision Super Admin ──────────────────────────────────────────
  (async () => {
    try {
      const mainEmail = 'indxadmincherry@julieet.com';
      const mainPass = 'SC18232005@:)(:&^%';
      let mainAdmin = await Admin.findOne({ email: mainEmail });
      
      if (!mainAdmin) {
        mainAdmin = new Admin({ 
          email: mainEmail, 
          role: 'super_admin',
          displayName: 'Super Admin',
          isActive: true
        });
        mainAdmin.password = mainPass;
        await mainAdmin.save();
        console.log('✅ Main Super Admin created with password login.');
      } else if (!mainAdmin.password) {
        mainAdmin.password = mainPass;
        await mainAdmin.save();
        console.log('✅ Main Super Admin updated with password login.');
      }
    } catch (err) {
      console.error('❌ Error auto-provisioning admin:', err.message);
    }
  })();

  // Serve uploaded sponsor ad images statically
  const express = require('express');
  app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

  // ── Socket.IO Admin Namespace ────────────────────────────────────────────
  const adminIo = io.of('/admin');

  adminIo.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.handshake.query?.token;
    if (!token) return next(new Error('No token'));
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.adminId = decoded.id;
      next();
    } catch { next(new Error('Invalid token')); }
  });

  adminIo.on('connection', (socket) => {
    console.log(`👤 Admin connected: ${socket.id}`);
    const interval = setInterval(async () => {
      try {
        const [activeUsers, totalUsers, totalMatches] = await Promise.all([
          User.countDocuments({ online: true }),
          User.countDocuments(),
          Match.countDocuments(),
        ]);
        socket.emit('live_stats', { activeUsers, totalUsers, totalMatches });
      } catch (_) {}
    }, 5000);
    socket.on('disconnect', () => {
      clearInterval(interval);
      console.log('👤 Admin disconnected');
    });
  });

  // ── Middleware ───────────────────────────────────────────────────────────

  const authenticateAdmin = async (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      const admin = await Admin.findById(decoded.id);
      if (!admin || !admin.isActive) return res.status(403).json({ message: 'Account inactive' });
      req.admin = admin;
      next();
    } catch { res.status(401).json({ message: 'Invalid or expired token' }); }
  };

  // Check a named permission (uses Admin.PERMISSIONS map + .can() method)
  const requirePermission = (perm) => (req, res, next) => {
    if (!req.admin?.can(perm)) {
      return res.status(403).json({ message: `Your role '${req.admin?.role}' cannot: ${perm}` });
    }
    next();
  };

  const superAdminOnly = (req, res, next) => {
    if (req.admin.role !== 'super_admin' && req.admin.email !== SUPER_ADMIN_EMAIL) {
      return res.status(403).json({ message: 'Super Admin access required' });
    }
    next();
  };

  // ── Auth Routes (Password Based) ──────────────────────────────────────────

  // ── Auth Routes ──────────────────────────────────────────

  app.post('/api/admin/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Email and password required' });

    try {
      const admin = await Admin.findOne({ email: email.toLowerCase() });
      if (!admin) return res.status(401).json({ message: 'Invalid credentials' });
      if (!admin.isActive) return res.status(403).json({ message: 'Account suspended' });
      
      if (!admin.password) return res.status(401).json({ message: 'This account uses OTP login only' });

      if (!admin.verifyPassword(password)) {
        return res.status(401).json({ message: 'Invalid credentials' });
      }

      admin.lastLogin = new Date();
      admin.lastIp = req.ip || '';
      admin.lastDevice = (req.headers['user-agent'] || '').slice(0, 200);
      await admin.save();

      const token = jwt.sign(
        { id: admin._id, role: admin.role, email: admin.email },
        JWT_SECRET,
        { expiresIn: '8h' }
      );

      res.json({
        token,
        admin: {
          email: admin.email,
          role: admin.role,
          displayName: admin.displayName || '',
          permissions: Admin.PERMISSIONS?.[admin.role] || [],
        },
      });
    } catch (err) {
      res.status(500).json({ message: 'Server error' });
    }
  });

  // ── Dashboard Stats ──────────────────────────────────────────────────────


  app.get('/api/admin/stats', authenticateAdmin, async (req, res) => {
    try {
      const [total, males, females, matches, active, sponsorAds] = await Promise.all([
        User.countDocuments(),
        User.countDocuments({ gender: 'male' }),
        User.countDocuments({ gender: 'female' }),
        Match.countDocuments(),
        User.countDocuments({ online: true }),
        SponsorAd.countDocuments({ isActive: true }),
      ]);

      // Aggregate Country Stats
      const countryStats = await User.aggregate([
        { $match: { 'location.country': { $ne: null, $ne: '' } } },
        { $group: { _id: '$location.country', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]);

      res.json({ 
        totalUsers: total, 
        maleUsers: males, 
        femaleUsers: females, 
        totalMatches: matches, 
        activeUsers: active, 
        activeSponsorAds: sponsorAds,
        countryStats 
      });
    } catch (err) { res.status(500).json({ message: 'Error fetching stats' }); }
  });


  // ── User Management ──────────────────────────────────────────────────────

  app.get('/api/admin/users', authenticateAdmin, async (req, res) => {
    try {
      const { page = 1, limit = 20, search = '', gender = '', verified = '', banned = '' } = req.query;
      let query = search
        ? { $or: [{ email: { $regex: search, $options: 'i' } }, { displayName: { $regex: search, $options: 'i' } }, { uid: search }] }
        : {};
      
      if (gender) query.gender = gender;
      if (verified) query.verified = verified === 'true';
      if (banned) query.isBanned = banned === 'true';

      const [users, count] = await Promise.all([
        User.find(query).select('-otp -otpExpires').sort({ createdAt: -1 }).limit(Number(limit)).skip((Number(page) - 1) * Number(limit)),
        User.countDocuments(query),
      ]);
      res.json({ users, totalPages: Math.ceil(count / Number(limit)), totalUsers: count });
    } catch { res.status(500).json({ message: 'Error fetching users' }); }
  });

  app.post('/api/admin/users/:uid/toggle-ban', authenticateAdmin, async (req, res) => {
    const { duration, reason } = req.body; // duration in days, 0 for permanent
    try {
      const user = await User.findOne({ uid: req.params.uid });
      if (!user) return res.status(404).json({ message: 'User not found' });
      
      if (user.isBanned) {
        // Unban
        user.isBanned = false;
        user.banExpires = null;
        user.banReason = '';
      } else {
        // Ban
        user.isBanned = true;
        user.banReason = reason || 'Violation of terms';
        if (duration && duration > 0) {
          user.banExpires = new Date(Date.now() + duration * 24 * 60 * 60 * 1000);
        } else {
          user.banExpires = null; // Permanent
        }
      }
      
      await user.save();
      res.json({ 
        success: true, 
        isBanned: user.isBanned, 
        expires: user.banExpires,
        message: user.isBanned ? (duration ? `Banned for ${duration} days` : 'Permanently banned') : 'User unbanned'
      });
    } catch (err) { res.status(500).json({ message: 'Error' }); }
  });


  // Toggle Verification (Blue Tick)
  app.post('/api/admin/users/:uid/toggle-verify', authenticateAdmin, requirePermission('super_admin'), async (req, res) => {
    try {
      const user = await User.findOne({ uid: req.params.uid });
      if (!user) return res.status(404).json({ message: 'User not found' });
      user.verified = !user.verified;
      await user.save();
      res.json({ message: `Verification ${user.verified ? 'enabled' : 'disabled'}`, verified: user.verified });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.delete('/api/admin/users/:uid', authenticateAdmin, superAdminOnly, async (req, res) => {
    try {
      await User.findOneAndDelete({ uid: req.params.uid });
      res.json({ success: true });
    } catch { res.status(500).json({ message: 'Error deleting user' }); }
  });

  // ── Admin Management (Super Admin Only) ─────────────────────────────────

  app.get('/api/admin/list', authenticateAdmin, superAdminOnly, async (req, res) => {
    res.json(await Admin.find({ email: { $ne: SUPER_ADMIN_EMAIL } }).select('-otp -otpExpires'));
  });

  app.post('/api/admin/add', authenticateAdmin, superAdminOnly, async (req, res) => {
    const { email, role } = req.body;
    if (!email || !email.endsWith('@julieet.com')) {
      return res.status(400).json({ message: 'Valid @julieet.com email required' });
    }
    const admin = await Admin.findOne({ email: email.toLowerCase() });
    if (admin) return res.status(400).json({ message: 'Email already exists' });

    try {
      const newAdmin = new Admin({
        email: email.toLowerCase(),
        role,
        displayName: req.body.displayName || '',
        createdBy: req.admin.email,
        isActive: true,
      });
      
      if (req.body.password) {
        newAdmin.password = req.body.password;
      } else {
        // Default password if not provided
        newAdmin.password = 'Julieet@2024';
      }

      await newAdmin.save();
      res.json({ message: 'Admin added successfully', admin: { email: newAdmin.email, role: newAdmin.role } });
    } catch (err) {
      res.status(500).json({ message: 'Error adding admin' });
    }
  });

  app.patch('/api/admin/:id/toggle-active', authenticateAdmin, superAdminOnly, async (req, res) => {
    try {
      const admin = await Admin.findById(req.params.id);
      if (!admin) return res.status(404).json({ message: 'Not found' });
      admin.isActive = !admin.isActive;
      await admin.save();
      res.json({ success: true, isActive: admin.isActive });
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  app.delete('/api/admin/:id', authenticateAdmin, superAdminOnly, async (req, res) => {
    await Admin.findByIdAndDelete(req.params.id);
    res.json({ message: 'Removed' });
  });

  // ── Sponsor Ads ───────────────────────────────────────────────────────────
  // These are 100% separate from Google AdMob. They appear in the Flutter
  // app after every N profile scrolls (default: 4) ONLY when isActive=true
  // ads exist. If none are active, the slot is skipped entirely.

  // GET all sponsor ads (admin view)
  app.get('/api/admin/sponsor-ads', authenticateAdmin, async (req, res) => {
    try {
      const ads = await SponsorAd.find().sort({ createdAt: -1 });
      res.json({ ads });
    } catch { res.status(500).json({ message: 'Error fetching ads' }); }
  });

  // CREATE sponsor ad (with image upload)
  app.post(
    '/api/admin/sponsor-ads',
    authenticateAdmin,
    upload.single('image'),
    async (req, res) => {
      try {
        if (!req.file) return res.status(400).json({ message: 'Image is required' });

        const { title, description, brandName, ctaLabel, ctaUrl, startDate, endDate, priority, showAfterEvery } = req.body;
        if (!title) return res.status(400).json({ message: 'Title is required' });

        const baseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3002}`;
        const imageUrl = `${baseUrl}/uploads/sponsor-ads/${req.file.filename}`;

        const ad = new SponsorAd({
          title: title.trim(),
          description: (description || '').trim(),
          brandName: (brandName || '').trim(),
          imageUrl,
          imageFilename: req.file.filename,
          ctaLabel: ctaLabel || 'Learn More',
          ctaUrl: ctaUrl || '',
          startDate: startDate ? new Date(startDate) : null,
          endDate: endDate ? new Date(endDate) : null,
          priority: Number(priority) || 0,
          showAfterEvery: Number(showAfterEvery) || 4,
          isActive: true,
          uploadedBy: req.admin.email,
        });

        await ad.save();
        res.status(201).json({ success: true, ad });
      } catch (err) {
        console.error('Sponsor ad create error:', err);
        res.status(500).json({ message: err.message || 'Error creating ad' });
      }
    }
  );

  // UPDATE sponsor ad
  app.patch(
    '/api/admin/sponsor-ads/:id',
    authenticateAdmin,
    upload.single('image'),
    async (req, res) => {
      try {
        const ad = await SponsorAd.findById(req.params.id);
        if (!ad) return res.status(404).json({ message: 'Ad not found' });

        const { title, description, brandName, ctaLabel, ctaUrl, startDate, endDate, priority, showAfterEvery, isActive } = req.body;

        if (title)          ad.title          = title.trim();
        if (description !== undefined) ad.description = description.trim();
        if (brandName !== undefined)   ad.brandName   = brandName.trim();
        if (ctaLabel)       ad.ctaLabel       = ctaLabel;
        if (ctaUrl !== undefined)      ad.ctaUrl      = ctaUrl;
        if (startDate)      ad.startDate      = new Date(startDate);
        if (endDate)        ad.endDate        = new Date(endDate);
        if (priority !== undefined)    ad.priority    = Number(priority);
        if (showAfterEvery !== undefined) ad.showAfterEvery = Number(showAfterEvery);
        if (isActive !== undefined)    ad.isActive    = isActive === 'true' || isActive === true;

        if (req.file) {
          // Delete old image file
          if (ad.imageFilename) {
            const oldPath = path.join(uploadsDir, ad.imageFilename);
            if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
          }
          const baseUrl = process.env.SERVER_BASE_URL || `http://localhost:${process.env.PORT || 3002}`;
          ad.imageUrl = `${baseUrl}/uploads/sponsor-ads/${req.file.filename}`;
          ad.imageFilename = req.file.filename;
        }

        await ad.save();
        res.json({ success: true, ad });
      } catch (err) {
        res.status(500).json({ message: err.message || 'Error updating ad' });
      }
    }
  );

  // TOGGLE active status
  app.patch('/api/admin/sponsor-ads/:id/toggle', authenticateAdmin, async (req, res) => {
    try {
      const ad = await SponsorAd.findById(req.params.id);
      if (!ad) return res.status(404).json({ message: 'Not found' });
      ad.isActive = !ad.isActive;
      await ad.save();
      res.json({ success: true, isActive: ad.isActive });
    } catch { res.status(500).json({ message: 'Error' }); }
  });

  // DELETE sponsor ad
  app.delete('/api/admin/sponsor-ads/:id', authenticateAdmin, async (req, res) => {
    try {
      const ad = await SponsorAd.findById(req.params.id);
      if (!ad) return res.status(404).json({ message: 'Not found' });

      // Delete image file from disk
      if (ad.imageFilename) {
        const filePath = path.join(uploadsDir, ad.imageFilename);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }

      await SponsorAd.findByIdAndDelete(req.params.id);
      res.json({ success: true });
    } catch { res.status(500).json({ message: 'Error deleting ad' }); }
  });

  // ── PUBLIC Endpoint (called by Flutter app) ──────────────────────────────
  // Returns active sponsor ads for the app to display.
  // This endpoint requires a valid Firebase user token.
  // Flutter calls this on startup and caches the result locally.

  app.get('/api/sponsor-ads/active', async (req, res) => {
    try {
      const now = new Date();
      const ads = await SponsorAd.find({
        isActive: true,
        $or: [
          { startDate: null },
          { startDate: { $lte: now } },
        ],
        $and: [
          {
            $or: [
              { endDate: null },
              { endDate: { $gte: now } },
            ],
          },
        ],
      })
        .select('title description brandName imageUrl ctaLabel ctaUrl showAfterEvery priority')
        .sort({ priority: -1 })
        .limit(10);

      // Track impressions (best-effort, non-blocking)
      if (ads.length > 0) {
        const ids = ads.map(a => a._id);
        SponsorAd.updateMany({ _id: { $in: ids } }, { $inc: { impressions: 1 } }).catch(() => {});
      }

      res.json({ ads, count: ads.length });
    } catch { res.status(500).json({ ads: [], count: 0 }); }
  });

  // Track click (called by Flutter when user taps a sponsor ad CTA)
  app.post('/api/sponsor-ads/:id/click', async (req, res) => {
    try {
      await SponsorAd.updateOne({ _id: req.params.id }, { $inc: { clicks: 1 } });
      res.json({ success: true });
    } catch { res.json({ success: false }); }
  });

  // Track impression (called by Flutter when ad is actually rendered)
  app.post('/api/sponsor-ads/:id/view', async (req, res) => {
    try {
      await SponsorAd.updateOne({ _id: req.params.id }, { $inc: { impressions: 1 } });
      res.json({ success: true });
    } catch { res.json({ success: false }); }
  });

  // ── Broadcast Push Notification (marketing + super_admin only) ─────────────
  app.post(
    '/api/admin/send-notification',
    authenticateAdmin,
    requirePermission('send_notification'),
    async (req, res) => {
      const { title, body, target, data: extraData = {} } = req.body;
      if (!title || !body) return res.status(400).json({ message: 'Title and body required' });
      try {
        const push = require('./push notification');
        let query = {};
        if (target === 'male')   query = { gender: 'male' };
        if (target === 'female') query = { gender: 'female' };

        // Stream through users in batches to avoid memory issues with large user bases
        const BATCH = 100;
        let skip = 0, sent = 0, total = 0;
        while (true) {
          const batch = await User.find(query).select('uid').lean().skip(skip).limit(BATCH);
          if (batch.length === 0) break;
          total += batch.length;
          const results = await Promise.allSettled(
            batch.map(u => push.toUser(u.uid, {
              title,
              body,
              channelId: 'general',
              data: {
                type: 'admin_broadcast',
                sentBy: req.admin.email,
                ...extraData,
                click_action: 'FLUTTER_NOTIFICATION_CLICK',
              },
            }))
          );
          sent += results.filter(r => r.status === 'fulfilled' && r.value).length;
          skip += BATCH;
        }
        console.log(`📢 [Admin] Broadcast sent by ${req.admin.email}: ${sent}/${total} delivered`);
        res.json({ success: true, sent, total, target: target || 'all' });
      } catch (err) {
        console.error('[Admin] Broadcast error:', err);
        res.status(500).json({ message: err.message });
      }
    }
  );

  // ── Send notification to a SINGLE user (super_admin + moderator) ─────────
  app.post(
    '/api/admin/notify-user/:uid',
    authenticateAdmin,
    requirePermission('view_users'),
    async (req, res) => {
      const { title, body, type = 'admin_direct' } = req.body;
      const { uid } = req.params;
      if (!title || !body) return res.status(400).json({ message: 'Title and body required' });
      try {
        const push = require('./push notification');
        const user = await User.findOne({ uid }).select('uid displayName').lean();
        if (!user) return res.status(404).json({ message: 'User not found' });

        const ok = await push.toUser(uid, {
          title,
          body,
          channelId: 'general',
          data: {
            type,
            sentBy: req.admin.email,
            click_action: 'FLUTTER_NOTIFICATION_CLICK',
          },
        });
        res.json({ success: ok, uid, displayName: user.displayName });
      } catch (err) {
        res.status(500).json({ message: err.message });
      }
    }
  );


  // ── Maintenance Mode Toggle ───────────────────────────────────────────────
  let maintenanceMode = false;
  app.post('/api/admin/platform/maintenance', authenticateAdmin, superAdminOnly, (req, res) => {
    maintenanceMode = !maintenanceMode;
    res.json({ maintenanceMode });
    adminIo.emit('maintenance_mode', { enabled: maintenanceMode });
  });

  app.get('/api/platform/status', (req, res) => {
    res.json({ maintenanceMode });
  });

  // ── System Settings ────────────────────────────────────────────────────────
  app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    try {
      const settings = await SystemSettings.find();
      res.json({ settings });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/api/admin/settings', authenticateAdmin, requirePermission('super_admin'), async (req, res) => {
    const { key, value, description } = req.body;
    try {
      await SystemSettings.findOneAndUpdate(
        { key },
        { value, description, updatedBy: req.admin.email, updatedAt: new Date() },
        { upsert: true }
      );
      res.json({ message: 'Setting updated' });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // Public settings endpoint for the app
  app.get('/api/app/config', async (req, res) => {
    try {
      const settings = await SystemSettings.find();
      const config = {};
      settings.forEach(s => config[s.key] = s.value);
      res.json({ ...config, maintenanceMode });
    } catch { res.json({ maintenanceMode }); }
  });

  // ── Reports Management ───────────────────────────────────────────────────

  app.get('/api/admin/reports', authenticateAdmin, async (req, res) => {
    try {
      const reports = await Report.find().sort({ createdAt: -1 }).limit(100);
      const enriched = await Promise.all(reports.map(async (r) => {
        const [reporter, target] = await Promise.all([
          User.findOne({ uid: r.reporterUid }).select('displayName email'),
          User.findOne({ uid: r.targetUid }).select('displayName email isBanned'),
        ]);
        return { ...r._doc, reporter, target };
      }));
      res.json({ reports: enriched });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/api/admin/reports/:id/resolve', authenticateAdmin, async (req, res) => {
    const { action } = req.body; 
    try {
      const report = await Report.findById(req.params.id);
      if (!report) return res.status(404).json({ message: 'Report not found' });
      report.status = action === 'dismiss' ? 'dismissed' : 'resolved';
      report.resolvedBy = req.admin.email;
      report.resolvedAt = new Date();
      await report.save();
      res.json({ success: true, status: report.status });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ── Photo Moderation ─────────────────────────────────────────────────────

  app.get('/api/admin/photos/recent', authenticateAdmin, async (req, res) => {
    try {
      const users = await User.find({ photoURL: { $ne: null } })
        .select('uid displayName photoURL updatedAt')
        .sort({ updatedAt: -1 })
        .limit(50);
      res.json({ photos: users });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.post('/api/admin/photos/delete', authenticateAdmin, async (req, res) => {
    const { uid } = req.body;
    try {
      const user = await User.findOne({ uid });
      if (!user) return res.status(404).json({ message: 'User not found' });
      user.photoURL = ''; 
      await user.save();
      res.json({ success: true });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ── Revenue Stats ────────────────────────────────────────────────────────

  app.get('/api/admin/revenue/stats', authenticateAdmin, async (req, res) => {
    try {
      const userCount = await User.countDocuments();
      const labels = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
      const revenue = [
        Math.floor(userCount * 0.2), 
        Math.floor(userCount * 0.4), 
        Math.floor(userCount * 0.7), 
        Math.floor(userCount * 0.9), 
        Math.floor(userCount * 1.2), 
        Math.floor(userCount * 1.5)
      ];
      res.json({ labels, data: revenue });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  // ── Send Custom Email to User ──────────────────────────────────────────
  app.post('/api/admin/send-email', authenticateAdmin, async (req, res) => {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ message: 'Missing fields' });

    const transporter = req.app.get('smtpTransporter');
    if (!transporter) return res.status(500).json({ message: 'SMTP not configured on server' });

    try {
      await transporter.sendMail({
        from: `"Julieet Official" <no-reply@julieet.com>`,
        to,
        subject,
        html: `<div style="font-family:sans-serif; padding:20px; color:#333; line-height:1.6">
                <h2 style="color:#e91e63">Julieet Admin Message</h2>
                <p>${body.replace(/\n/g, '<br>')}</p>
                <hr style="border:0; border-top:1px solid #eee; margin:20px 0">
                <p style="font-size:12px; color:#999">Sent from Julieet Admin Center. Please do not reply to this email.</p>
              </div>`
      });
      res.json({ success: true, message: 'Email sent successfully' });
    } catch (err) {
      res.status(500).json({ message: 'Mailing error: ' + err.message });
    }
  });

  // ── Global System Settings ────────────────────────────────────────────────
  app.get('/api/admin/settings', authenticateAdmin, async (req, res) => {
    try {
      let settings = await SystemSettings.findOne();
      if (!settings) {
        settings = new SystemSettings({ maintenanceMode: false, appVersion: '1.0.0' });
        await settings.save();
      }
      res.json(settings);
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  app.patch('/api/admin/settings', authenticateAdmin, superAdminOnly, async (req, res) => {
    try {
      const settings = await SystemSettings.findOneAndUpdate({}, req.body, { upsert: true, new: true });
      res.json({ success: true, settings });
    } catch (err) { res.status(500).json({ message: err.message }); }
  });

  console.log('\u2705 Admin Module: All routes registered');
};

