#!/usr/bin/env node


const http = require('http');
const fs   = require('fs');
const path = require('path');

const HOST = process.env.CLOUD_HOST || 'localhost';
const PORT = process.env.CLOUD_PORT || 3000;
const BASE = `http://${HOST}:${PORT}`;

// ── HTTP helpers ─────────────────────────────────────────────────
function get(url) {
  return new Promise((res, rej) => {
    http.get(url, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    }).on('error', rej);
  });
}

function del(url) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, port: u.port, path: u.pathname, method: 'DELETE' };
    const req = http.request(opts, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej);
    req.end();
  });
}

function upload(filePath) {
  return new Promise((res, rej) => {
    const buf      = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const boundary = '----CloudBoundary' + Date.now();
    const header   = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n`
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body   = Buffer.concat([header, buf, footer]);

    const opts = {
      hostname: HOST, port: PORT, path: '/api/upload', method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': body.length }
    };
    const req = http.request(opts, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => res(JSON.parse(d)));
    });
    req.on('error', rej);
    req.write(body);
    req.end();
  });
}

function download(fileId, outPath) {
  return new Promise((res, rej) => {
    http.get(`${BASE}/api/download/${fileId}`, r => {
      if (r.statusCode !== 200) { rej(new Error(`HTTP ${r.statusCode}`)); return; }
      const name = (r.headers['content-disposition'] || '').match(/filename="(.+)"/)?.[1] || fileId;
      const dest = outPath || path.join(process.cwd(), name);
      const ws   = fs.createWriteStream(dest);
      r.pipe(ws);
      ws.on('finish', () => res({ dest, blocks: r.headers['x-block-count'], checksum: r.headers['x-file-checksum'] }));
    }).on('error', rej);
  });
}

// ── Formatting ────────────────────────────────────────────────────
const c = {
  cyan:   s => `\x1b[36m${s}\x1b[0m`,
  green:  s => `\x1b[32m${s}\x1b[0m`,
  red:    s => `\x1b[31m${s}\x1b[0m`,
  yellow: s => `\x1b[33m${s}\x1b[0m`,
  bold:   s => `\x1b[1m${s}\x1b[0m`,
  dim:    s => `\x1b[2m${s}\x1b[0m`,
};

function fmt(bytes) {
  if (bytes < 1024)    return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1) + ' KB';
  return (bytes/1048576).toFixed(2) + ' MB';
}

function banner() {
  console.log(c.cyan('\n╔══════════════════════════════════════╗'));
  console.log(c.cyan('║  SaaS Cloud CLI  ·  HDFS Block Store  ║'));
  console.log(c.cyan('╚══════════════════════════════════════╝\n'));
}

// ── Commands ──────────────────────────────────────────────────────
const cmds = {
  async status() {
    const d = await get(`${BASE}/api/status`);
    console.log(c.bold('\nCloud Node Status'));
    console.log('─────────────────────────────────────');
    console.log(`  Node        : ${c.cyan(d.node)}`);
    console.log(`  Status      : ${c.green('● ONLINE')}`);
    console.log(`  Files       : ${d.files}`);
    console.log(`  Blocks      : ${d.totalBlocks}`);
    console.log(`  Storage     : ${fmt(d.totalBytes)}`);
    console.log(`  Block Size  : ${d.blockSize / 1024} KB`);
    console.log(`  Replication : ${d.replication}`);
    console.log(`  Encryption  : ${c.green('AES-256-GCM')}`);
    console.log(`  Uptime      : ${Math.floor(d.uptime)}s\n`);
  },

  async list() {
    const files = await get(`${BASE}/api/files`);
    if (!files.length) { console.log(c.dim('  No files in namespace.')); return; }
    console.log(c.bold('\n  NAME                          SIZE       BLOCKS   UPLOADED'));
    console.log('  ' + '─'.repeat(70));
    files.forEach(f => {
      const name  = f.originalName.padEnd(30).slice(0, 30);
      const size  = fmt(f.originalSize).padStart(9);
      const blks  = String(f.blockCount).padStart(6);
      const date  = new Date(f.uploadedAt).toLocaleString();
      console.log(`  ${c.cyan(name)} ${size}  ${blks}   ${c.dim(date)}`);
      console.log(`  ${c.dim('  id: ' + f.fileId)}`);
    });
    console.log();
  },

  async upload(filePath) {
    if (!filePath) { console.log(c.red('Usage: node cloud-cli.js upload <filepath>')); return; }
    if (!fs.existsSync(filePath)) { console.log(c.red('File not found: ' + filePath)); return; }
    const stat = fs.statSync(filePath);
    const blks = Math.ceil(stat.size / 65536);
    console.log(`\n  Uploading ${c.cyan(path.basename(filePath))} (${fmt(stat.size)} → ${blks} blocks)…`);
    const d = await upload(filePath);
    if (d.success) {
      console.log(c.green(`  ✓ Uploaded successfully`));
      console.log(`    File ID    : ${c.cyan(d.fileId)}`);
      console.log(`    Blocks     : ${d.blockCount}`);
      console.log(`    Checksum   : ${d.checksum.slice(0, 24)}…\n`);
    } else {
      console.log(c.red('  ✗ Upload failed: ' + d.error));
    }
  },

  async download(fileId, outPath) {
    if (!fileId) { console.log(c.red('Usage: node cloud-cli.js download <fileId> [output-path]')); return; }
    console.log(`\n  Downloading ${c.cyan(fileId)}…`);
    const d = await download(fileId, outPath);
    console.log(c.green(`  ✓ Downloaded: ${d.dest}`));
    console.log(`    Blocks     : ${d.blocks}`);
    console.log(`    SHA-256    : ${(d.checksum||'').slice(0,24)}…\n`);
  },

  async info(fileId) {
    if (!fileId) { console.log(c.red('Usage: node cloud-cli.js info <fileId>')); return; }
    const f = await get(`${BASE}/api/files/${fileId}`);
    if (f.error) { console.log(c.red('  ✗ ' + f.error)); return; }
    console.log(c.bold(`\n  ${f.originalName}`));
    console.log('  ' + '─'.repeat(50));
    console.log(`  File ID    : ${c.cyan(f.fileId)}`);
    console.log(`  Size       : ${fmt(f.originalSize)}`);
    console.log(`  Blocks     : ${f.blockCount} × ${f.blockSize/1024} KB`);
    console.log(`  Encryption : ${c.green(f.encryption)}`);
    console.log(`  Replication: ${f.replication}`);
    console.log(`  Checksum   : ${c.dim(f.checksum)}`);
    console.log(`  Uploaded   : ${new Date(f.uploadedAt).toLocaleString()}`);
    console.log('\n  Block Map:');
    f.blocks.forEach((b, i) => {
      console.log(`    [${String(i).padStart(3,'0')}] ${c.dim(b.blockId)} ${fmt(b.size).padStart(8)} sha256:${b.checksum}`);
    });
    console.log();
  },

  async delete(fileId) {
    if (!fileId) { console.log(c.red('Usage: node cloud-cli.js delete <fileId>')); return; }
    const d = await del(`${BASE}/api/files/${fileId}`);
    if (d.success) console.log(c.green(`\n  ✓ Deleted: ${d.deleted}\n`));
    else console.log(c.red('  ✗ ' + (d.error || 'Failed')));
  }
};

// ── Main ──────────────────────────────────────────────────────────
(async () => {
  banner();
  const [,, cmd, ...args] = process.argv;
  if (!cmd || !cmds[cmd]) {
    console.log('  Commands: status | list | upload <file> | download <id> | info <id> | delete <id>\n');
    return;
  }
  try { await cmds[cmd](...args); }
  catch(e) { console.log(c.red('  ✗ Error: ' + e.message)); }
})();
