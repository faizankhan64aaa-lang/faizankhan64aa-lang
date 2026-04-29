/* ============================================
   PixCut AI - Express Backend Server
   Handles image upload, AI background removal,
   and processed image downloads.
   ============================================ */

require('dotenv').config();
const express = require('express');
const multer = require('multer');
const axios = require('axios');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const FormData = require('form-data');

const app = express();
const PORT = process.env.PORT || 3000;

// -------------------- Middleware --------------------
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use('/processed', express.static(path.join(__dirname, 'processed')));

// -------------------- Ensure Directories --------------------
['uploads', 'processed'].forEach(dir => {
  const dirPath = path.join(__dirname, dir);
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
});

// -------------------- Multer Config --------------------
const maxSize = (process.env.MAX_FILE_SIZE || 10) * 1024 * 1024; // MB to bytes

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => {
    const uniqueName = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/bmp'];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error('Invalid file type. Only PNG, JPG, WEBP, BMP are allowed.'), false);
  }
};

const upload = multer({ storage, fileFilter, limits: { fileSize: maxSize } });

// -------------------- Simple Rate Limiting --------------------
// In-memory store (resets on server restart — use Redis for production)
const usageTracker = {};
const DAILY_LIMIT = parseInt(process.env.FREE_DAILY_LIMIT) || 5;

function checkRateLimit(ip) {
  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  if (!usageTracker[ip] || usageTracker[ip].date !== today) {
    usageTracker[ip] = { date: today, count: 0 };
  }
  if (usageTracker[ip].count >= DAILY_LIMIT) {
    return false;
  }
  usageTracker[ip].count++;
  return true;
}

// -------------------- Processing History --------------------
// In-memory store for image processing history
const history = [];

// ==================== API ROUTES ====================

/**
 * POST /api/remove-bg
 * Upload an image and remove its background using remove.bg API
 */
app.post('/api/remove-bg', upload.single('image'), async (req, res) => {
  try {
    // Validate file exists
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No image file uploaded.' });
    }

    // Check rate limit
    const clientIP = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(clientIP)) {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(429).json({
        success: false,
        error: `Daily limit reached (${DAILY_LIMIT} images/day). Upgrade to Pro for more!`
      });
    }

    // Check API key
    const apiKey = process.env.REMOVEBG_API_KEY;
    if (!apiKey || apiKey === 'YOUR_API_KEY_HERE') {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(500).json({
        success: false,
        error: 'API key not configured. Please set REMOVEBG_API_KEY in .env file.'
      });
    }

    console.log(`📤 Processing image: ${req.file.originalname} (${(req.file.size / 1024).toFixed(1)} KB)`);

    // Send to remove.bg API
    const formData = new FormData();
    formData.append('image_file', fs.createReadStream(req.file.path));
    formData.append('size', 'auto');

    const response = await axios({
      method: 'post',
      url: 'https://api.remove.bg/v1.0/removebg',
      data: formData,
      headers: {
        ...formData.getHeaders(),
        'X-Api-Key': apiKey
      },
      responseType: 'arraybuffer',
      timeout: 30000 // 30 seconds timeout
    });

    // Save processed image
    const processedName = `processed_${uuidv4()}.png`;
    const processedPath = path.join(__dirname, 'processed', processedName);
    fs.writeFileSync(processedPath, response.data);

    // Store in history
    const record = {
      id: uuidv4(),
      originalName: req.file.originalname,
      originalPath: `/uploads/${req.file.filename}`,
      processedPath: `/processed/${processedName}`,
      processedAt: new Date().toISOString(),
      fileSize: req.file.size
    };
    history.unshift(record);
    // Keep only last 100 records in memory
    if (history.length > 100) history.pop();

    console.log(`✅ Background removed successfully: ${processedName}`);

    res.json({
      success: true,
      data: {
        id: record.id,
        originalUrl: record.originalPath,
        processedUrl: record.processedPath,
        downloadUrl: `/api/download/${processedName}`,
        processedAt: record.processedAt
      }
    });

  } catch (error) {
    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    // Handle specific API errors
    if (error.response) {
      const status = error.response.status;
      let message = 'Background removal failed.';

      if (status === 402) {
        message = 'API credits exhausted. Please check your remove.bg account.';
      } else if (status === 403) {
        message = 'Invalid API key. Please check your REMOVEBG_API_KEY in .env file.';
      } else if (status === 400) {
        message = 'Invalid image. Please upload a valid image file.';
      } else if (status === 429) {
        message = 'Too many requests to the API. Please wait a moment.';
      }

      console.error(`❌ API Error (${status}): ${message}`);
      return res.status(status).json({ success: false, error: message });
    }

    console.error('❌ Server Error:', error.message);
    res.status(500).json({ success: false, error: 'Server error. Please try again later.' });
  }
});

/**
 * GET /api/download/:filename
 * Download a processed image
 */
app.get('/api/download/:filename', (req, res) => {
  const filePath = path.join(__dirname, 'processed', req.params.filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: 'File not found.' });
  }

  // Counter logic
  const counterFile = path.join(__dirname, 'counter.txt');
  let count = 1;
  if (fs.existsSync(counterFile)) {
    count = parseInt(fs.readFileSync(counterFile, 'utf8')) || 1;
  }
  
  const paddedCount = String(count).padStart(2, '0');
  const downloadName = `bg_removed_${paddedCount}.png`;
  
  fs.writeFileSync(counterFile, String(count + 1));

  res.download(filePath, downloadName, (err) => {
    if (err) {
      console.error('Download error:', err.message);
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Download failed.' });
    }
  });
});

/**
 * GET /api/history
 * Get processing history
 */
app.get('/api/history', (req, res) => {
  res.json({ success: true, data: history.slice(0, 20) });
});

/**
 * GET /api/status
 * Server health check & API key status
 */
app.get('/api/status', (req, res) => {
  const apiKey = process.env.REMOVEBG_API_KEY;
  const configured = apiKey && apiKey !== 'YOUR_API_KEY_HERE';
  const clientIP = req.ip || req.connection.remoteAddress;
  const today = new Date().toISOString().split('T')[0];
  const usage = usageTracker[clientIP];
  const usedToday = (usage && usage.date === today) ? usage.count : 0;

  res.json({
    success: true,
    data: {
      serverRunning: true,
      apiConfigured: configured,
      dailyLimit: DAILY_LIMIT,
      usedToday: usedToday,
      remaining: DAILY_LIMIT - usedToday
    }
  });
});

/**
 * DELETE /api/cleanup
 * Clean up old files (admin endpoint)
 */
app.delete('/api/cleanup', (req, res) => {
  let cleaned = 0;
  ['uploads', 'processed'].forEach(dir => {
    const dirPath = path.join(__dirname, dir);
    const files = fs.readdirSync(dirPath);
    files.forEach(file => {
      const filePath = path.join(dirPath, file);
      const stats = fs.statSync(filePath);
      const ageHours = (Date.now() - stats.mtimeMs) / (1000 * 60 * 60);
      // Delete files older than 24 hours
      if (ageHours > 24) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    });
  });
  res.json({ success: true, message: `Cleaned ${cleaned} old files.` });
});

// -------------------- Error Handling --------------------
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        success: false,
        error: `File too large. Maximum size is ${process.env.MAX_FILE_SIZE || 10}MB.`
      });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
  next();
});

// -------------------- Catch-all → serve frontend --------------------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// -------------------- Start Server --------------------
app.listen(PORT, () => {
  const apiKey = process.env.REMOVEBG_API_KEY;
  const configured = apiKey && apiKey !== 'YOUR_API_KEY_HERE';

  console.log('');
  console.log('╔═══════════════════════════════════════════╗');
  console.log('║        ✂  PixCut AI — Server Running      ║');
  console.log('╠═══════════════════════════════════════════╣');
  console.log(`║  🌐 URL:  http://localhost:${PORT}            ║`);
  console.log(`║  🔑 API:  ${configured ? '✅ Configured' : '❌ Not configured'}              ║`);
  console.log(`║  📁 Max:  ${process.env.MAX_FILE_SIZE || 10}MB per image              ║`);
  console.log(`║  🎯 Limit: ${DAILY_LIMIT} images/day (free)          ║`);
  console.log('╚═══════════════════════════════════════════╝');
  console.log('');

  if (!configured) {
    console.log('⚠️  To enable background removal:');
    console.log('   1. Go to https://www.remove.bg/api#remove-background');
    console.log('   2. Sign up for a FREE API key (50 images/month)');
    console.log('   3. Add it to .env file: REMOVEBG_API_KEY=your_key_here');
    console.log('   4. Restart the server');
    console.log('');
  }
});
