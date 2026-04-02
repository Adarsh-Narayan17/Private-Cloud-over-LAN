const express    = require('express');
const multer     = require('multer');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const cors       = require('cors');

const app  = express();
const PORT = process.env.PORT || 3000;
const BLOCK_DIR    = path.join(__dirname, '../storage/blocks');
const META_DIR     = path.join(__dirname, '../storage/metadata');
const BLOCK_SIZE   = 64 * 1024; // 64 KB per block (like HDFS default, scaled down)
const REPLICATION  = 1;         

[BLOCK_DIR, META_DIR].forEach(d => fs.mkdirSync(d, { recursive: true }));

// ── Middleware ───────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client/public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

// ══════════════════════════════════════════════════════════════════
//  CRYPTO HELPERS  — AES-256-GCM authenticated encryption
// ══════════════════════════════════════════════════════════════════

const MASTER_KEY = crypto.scryptSync(
  process.env.CLOUD_SECRET || 'saas-cloud-lab-secret-2024',
  'hdfs-salt-v1',
  32
);

function encryptBlock(data) {
  const iv         = crypto.randomBytes(12);
  const cipher     = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const encrypted  = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag    = cipher.getAuthTag();
  // Layout: [12B iv][16B authTag][...ciphertext]
  return Buffer.concat([iv, authTag, encrypted]);
}

function decryptBlock(blob) {
  const iv         = blob.subarray(0, 12);
  const authTag    = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);
  const decipher   = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

// ══════════════════════════════════════════════════════════════════
//  BLOCK ENGINE  — Split / store / retrieve
// ══════════════════════════════════════════════════════════════════

function splitIntoBlocks(buffer) {
  const blocks = [];
  let offset = 0;
  while (offset < buffer.length) {
    blocks.push(buffer.subarray(offset, offset + BLOCK_SIZE));
    offset += BLOCK_SIZE;
  }
  return blocks;
}

function saveBlock(blockId, data) {
  const encrypted = encryptBlock(data);
  fs.writeFileSync(path.join(BLOCK_DIR, blockId), encrypted);
  return {
    blockId,
    size: data.length,
    encryptedSize: encrypted.length,
    checksum: crypto.createHash('sha256').update(data).digest('hex').slice(0, 16)
  };
}

function loadBlock(blockId) {
  const blob = fs.readFileSync(path.join(BLOCK_DIR, blockId));
  return decryptBlock(blob);
}

function saveMetadata(fileId, meta) {
  fs.writeFileSync(path.join(META_DIR, `${fileId}.json`), JSON.stringify(meta, null, 2));
}

function loadMetadata(fileId) {
  const p = path.join(META_DIR, `${fileId}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function listAllFiles() {
  return fs.readdirSync(META_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(META_DIR, f), 'utf8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.uploadedAt - a.uploadedAt);
}
app.get('/api/status', (req, res) => {
  const files      = listAllFiles();
  const totalBytes = files.reduce((s, f) => s + f.originalSize, 0);
  const totalBlocks = files.reduce((s, f) => s + f.blocks.length, 0);

  res.json({
    status      : 'online',
    node        : 'NameNode-1 (DataNode-1)',
    blockSize   : BLOCK_SIZE,
    replication : REPLICATION,
    files       : files.length,
    totalBlocks,
    totalBytes,
    uptime      : process.uptime()
  });
});
app.get('/api/files', (req, res) => {
  res.json(listAllFiles());
});
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const fileId    = crypto.randomUUID();
  const buffer    = req.file.buffer;
  const rawBlocks = splitIntoBlocks(buffer);

  const blockMeta = rawBlocks.map((blk, idx) => {
    const blockId = `${fileId}_blk${String(idx).padStart(4, '0')}`;
    return saveBlock(blockId, blk);
  });

  const checksum = crypto.createHash('sha256').update(buffer).digest('hex');

  const metadata = {
    fileId,
    originalName : req.file.originalname,
    mimeType     : req.file.mimetype,
    originalSize : buffer.length,
    blockSize    : BLOCK_SIZE,
    blockCount   : rawBlocks.length,
    replication  : REPLICATION,
    checksum,
    blocks       : blockMeta,
    uploadedAt   : Date.now(),
    encryption   : 'AES-256-GCM'
  };

  saveMetadata(fileId, metadata);

  console.log(`[UPLOAD] ${req.file.originalname} → ${rawBlocks.length} blocks, id=${fileId}`);
  res.json({ success: true, fileId, blockCount: rawBlocks.length, checksum });
});

// ── GET /api/download/:fileId ────────────────────────────────────
app.get('/api/download/:fileId', (req, res) => {
  const meta = loadMetadata(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'File not found' });

  try {
    const parts = meta.blocks.map(b => loadBlock(b.blockId));
    const assembled = Buffer.concat(parts);

    // Verify integrity
    const checksum = crypto.createHash('sha256').update(assembled).digest('hex');
    if (checksum !== meta.checksum) {
      return res.status(500).json({ error: 'Checksum mismatch — data integrity violated' });
    }

    res.setHeader('Content-Disposition', `attachment; filename="${meta.originalName}"`);
    res.setHeader('Content-Type', meta.mimeType || 'application/octet-stream');
    res.setHeader('X-Block-Count', meta.blockCount);
    res.setHeader('X-File-Checksum', meta.checksum);
    res.send(assembled);

    console.log(`[DOWNLOAD] ${meta.originalName} ← assembled ${meta.blockCount} blocks`);
  } catch (err) {
    console.error('[DOWNLOAD ERROR]', err.message);
    res.status(500).json({ error: 'Decryption or reassembly failed', detail: err.message });
  }
});

// ── GET /api/files/:fileId ───────────────────────────────────────
app.get('/api/files/:fileId', (req, res) => {
  const meta = loadMetadata(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'File not found' });
  res.json(meta);
});

// ── DELETE /api/files/:fileId ────────────────────────────────────
app.delete('/api/files/:fileId', (req, res) => {
  const meta = loadMetadata(req.params.fileId);
  if (!meta) return res.status(404).json({ error: 'File not found' });

  meta.blocks.forEach(b => {
    const p = path.join(BLOCK_DIR, b.blockId);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  });
  fs.unlinkSync(path.join(META_DIR, `${meta.fileId}.json`));

  console.log(`[DELETE] ${meta.originalName} — ${meta.blockCount} blocks removed`);
  res.json({ success: true, deleted: meta.originalName });
});

// ── Start ────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║        SaaS Cloud Controller — HDFS Engine           ║');
  console.log(`║   Server : http://0.0.0.0:${PORT}                       ║`);
  console.log(`║   LAN    : http://<your-ip>:${PORT}                      ║`);
  console.log(`║   Block  : ${BLOCK_SIZE / 1024} KB  |  Encryption: AES-256-GCM   ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});
