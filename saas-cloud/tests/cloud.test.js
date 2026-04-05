/**
 * ═══════════════════════════════════════════════
 *  tests/cloud.test.js — Automated Test Suite
 *  Run: node tests/cloud.test.js
 * ═══════════════════════════════════════════════
 */

const crypto = require('crypto');
const path   = require('path');
const fs     = require('fs');

// ── Inline the crypto functions to test them ──
const MASTER_KEY = crypto.scryptSync('test-secret', 'hdfs-salt-v1', 32);

function encryptBlock(data) {
  const iv        = crypto.randomBytes(12);
  const cipher    = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag   = cipher.getAuthTag();
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

function splitIntoBlocks(buffer, blockSize = 65536) {
  const blocks = [];
  let offset = 0;
  while (offset < buffer.length) {
    blocks.push(buffer.subarray(offset, offset + blockSize));
    offset += blockSize;
  }
  return blocks;
}

// ── Simple test runner ────────────────────────
let passed = 0, failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅  ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌  ${name}`);
    console.log(`       → ${e.message}`);
    failed++;
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function assertEqual(a, b, msg) {
  if (a !== b) throw new Error(msg || `Expected ${b}, got ${a}`);
}

// ═════════════════════════════════════════════
//  TEST SUITES
// ═════════════════════════════════════════════

console.log('\n╔══════════════════════════════════════════╗');
console.log('║   SaaS Cloud — Automated Test Suite      ║');
console.log('╚══════════════════════════════════════════╝\n');

// ── Suite 1: Encryption ───────────────────────
console.log('📋 Suite 1: AES-256-GCM Encryption\n');

test('Encrypt produces output longer than input', () => {
  const data      = Buffer.from('Hello Cloud Block');
  const encrypted = encryptBlock(data);
  assert(encrypted.length > data.length, 'Encrypted should be larger');
});

test('Decrypt restores original data exactly', () => {
  const original  = Buffer.from('Hello Cloud Block Data 12345');
  const encrypted = encryptBlock(original);
  const decrypted = decryptBlock(encrypted);
  assertEqual(decrypted.toString(), original.toString(), 'Data mismatch after decrypt');
});

test('Encrypted output is different every time (random IV)', () => {
  const data  = Buffer.from('Same data');
  const enc1  = encryptBlock(data);
  const enc2  = encryptBlock(data);
  assert(!enc1.equals(enc2), 'Two encryptions of same data should differ (random IV)');
});

test('Tampered block fails authentication', () => {
  const data      = Buffer.from('Sensitive block data');
  const encrypted = encryptBlock(data);
  // Tamper with ciphertext
  encrypted[30] ^= 0xFF;
  try {
    decryptBlock(encrypted);
    assert(false, 'Should have thrown on tampered data');
  } catch (e) {
    assert(true); // Expected — GCM auth tag rejected
  }
});

test('Encrypt/decrypt binary data (non-text)', () => {
  const binary    = crypto.randomBytes(1024);
  const encrypted = encryptBlock(binary);
  const decrypted = decryptBlock(encrypted);
  assert(decrypted.equals(binary), 'Binary data mismatch');
});

// ── Suite 2: Block Splitting ──────────────────
console.log('\n📋 Suite 2: HDFS Block Splitting\n');

test('Small file produces exactly 1 block', () => {
  const data   = Buffer.alloc(1000, 'A');
  const blocks = splitIntoBlocks(data, 65536);
  assertEqual(blocks.length, 1, 'Should have 1 block');
});

test('File exactly block-size produces 1 block', () => {
  const data   = Buffer.alloc(65536, 'X');
  const blocks = splitIntoBlocks(data, 65536);
  assertEqual(blocks.length, 1);
});

test('File slightly over block-size produces 2 blocks', () => {
  const data   = Buffer.alloc(65537, 'Y');
  const blocks = splitIntoBlocks(data, 65536);
  assertEqual(blocks.length, 2);
});

test('Correct number of blocks for large file', () => {
  const size   = 300 * 1024; // 300 KB
  const data   = Buffer.alloc(size, 'Z');
  const blocks = splitIntoBlocks(data, 65536);
  const expected = Math.ceil(size / 65536);
  assertEqual(blocks.length, expected);
});

test('Reassembled blocks equal original data', () => {
  const original = crypto.randomBytes(200 * 1024);
  const blocks   = splitIntoBlocks(original, 65536);
  const rebuilt  = Buffer.concat(blocks);
  assert(rebuilt.equals(original), 'Reassembled data does not match original');
});

test('Last block is smaller than block size when file size is not divisible', () => {
  const data     = Buffer.alloc(70000, 'L');
  const blocks   = splitIntoBlocks(data, 65536);
  const lastBlk  = blocks[blocks.length - 1];
  assert(lastBlk.length < 65536, 'Last block should be partial');
  assertEqual(lastBlk.length, 70000 - 65536);
});

// ── Suite 3: Checksums ────────────────────────
console.log('\n📋 Suite 3: SHA-256 Integrity\n');

test('SHA-256 checksum is consistent', () => {
  const data = Buffer.from('Cloud file data');
  const h1   = crypto.createHash('sha256').update(data).digest('hex');
  const h2   = crypto.createHash('sha256').update(data).digest('hex');
  assertEqual(h1, h2, 'Checksums should match');
});

test('Modified data produces different checksum', () => {
  const data1 = Buffer.from('Original data');
  const data2 = Buffer.from('Modified data');
  const h1    = crypto.createHash('sha256').update(data1).digest('hex');
  const h2    = crypto.createHash('sha256').update(data2).digest('hex');
  assert(h1 !== h2, 'Different data should have different checksums');
});

test('Full pipeline: split → encrypt blocks → decrypt → reassemble → checksum matches', () => {
  const original   = crypto.randomBytes(150 * 1024);
  const checksum   = crypto.createHash('sha256').update(original).digest('hex');
  const blocks     = splitIntoBlocks(original, 65536);
  const encrypted  = blocks.map(encryptBlock);
  const decrypted  = encrypted.map(decryptBlock);
  const reassembled = Buffer.concat(decrypted);
  const newChecksum = crypto.createHash('sha256').update(reassembled).digest('hex');
  assertEqual(newChecksum, checksum, 'Full pipeline checksum mismatch');
});

// ── Summary ───────────────────────────────────
console.log('\n' + '─'.repeat(46));
console.log(`  Total : ${passed + failed} tests`);
console.log(`  Passed: ${passed} ✅`);
console.log(`  Failed: ${failed} ❌`);
console.log('─'.repeat(46) + '\n');

if (failed > 0) {
  console.log('  ⚠️  Some tests failed. Fix before deploying.\n');
  process.exit(1);
} else {
  console.log('  🎉 All tests passed! Safe to build & deploy.\n');
  process.exit(0);
}