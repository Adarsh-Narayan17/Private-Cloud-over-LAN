# ☁ SaaS Cloud Controller — HDFS Block Storage

A fully functional **private cloud storage system** built over a LAN, inspired by HDFS (Hadoop Distributed File System) architecture. Files are split into fixed-size blocks, **individually encrypted with AES-256-GCM**, stored on-disk, and reassembled on download with SHA-256 integrity verification.

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    SaaS Cloud Controller                    │
│                                                             │
│  ┌──────────────┐    ┌──────────────────────────────────┐  │
│  │  NameNode    │    │         DataNode                 │  │
│  │  (Metadata)  │    │  ┌──────┐ ┌──────┐ ┌──────┐    │  │
│  │  · file IDs  │───▶│  │BLK_0 │ │BLK_1 │ │BLK_N │    │  │
│  │  · block map │    │  │🔒AES │ │🔒AES │ │🔒AES │    │  │
│  │  · checksums │    │  └──────┘ └──────┘ └──────┘    │  │
│  └──────────────┘    └──────────────────────────────────┘  │
│                                                             │
│  REST API  ·  Web Dashboard  ·  CLI Client                  │
└─────────────────────────────────────────────────────────────┘
```

## 📦 Project Structure

```
saas-cloud/
├── server/
│   └── cloud_controller.js   ← Main server (NameNode + DataNode)
├── client/
│   └── public/
│       └── index.html        ← Web dashboard UI
├── storage/
│   ├── blocks/               ← Encrypted block files (auto-created)
│   └── metadata/             ← JSON metadata per file (auto-created)
├── cloud-cli.js              ← Command-line client
├── package.json
├── .vscode/
│   ├── launch.json           ← VS Code debug configs
│   └── tasks.json            ← VS Code tasks
└── README.md
```

---

## 🚀 Quick Start (VS Code)

### 1. Install dependencies
```bash
npm install
```
Or use **VS Code Task**: `Ctrl+Shift+P` → `Tasks: Run Task` → `Install Dependencies`

### 2. Start the server
```bash
npm start
```
Or press **F5** in VS Code with `▶ Start Cloud Controller` selected.

### 3. Open the dashboard
```
http://localhost:3000
```

### 4. Access from other LAN machines
```
http://<your-ip>:3000
```

---

## 🔧 REST API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/api/status` | Node status, stats |
| `GET`  | `/api/files` | List all uploaded files |
| `POST` | `/api/upload` | Upload file (multipart/form-data) |
| `GET`  | `/api/download/:fileId` | Download & decrypt file |
| `GET`  | `/api/files/:fileId` | Get block metadata |
| `DELETE` | `/api/files/:fileId` | Delete file + all blocks |

---

## 💻 CLI Usage

```bash
# Check node status
node cloud-cli.js status

# List all files
node cloud-cli.js list

# Upload a file
node cloud-cli.js upload ./myfile.pdf

# Download a file
node cloud-cli.js download <fileId>

# Show block map & metadata
node cloud-cli.js info <fileId>

# Delete a file
node cloud-cli.js delete <fileId>
```

Connect CLI to a remote node:
```bash
CLOUD_HOST=192.168.1.105 CLOUD_PORT=3000 node cloud-cli.js list
```

---

## 🔐 How Encryption Works

Each block follows this pipeline:

```
Raw Block Data (64 KB)
        │
        ▼
┌───────────────────────────────────┐
│  AES-256-GCM Encryption           │
│  • Random 12-byte IV per block    │
│  • 16-byte authentication tag     │
│  • Master key via scrypt KDF      │
└───────────────────────────────────┘
        │
        ▼
Stored on disk:
[12B IV][16B AuthTag][...Ciphertext]
```

On download:
1. All encrypted blocks are loaded from disk
2. Each block is **authenticated** (GCM tag check) and decrypted
3. Blocks are concatenated to rebuild the original file
4. SHA-256 checksum is verified against stored metadata

---

## 📐 HDFS Concepts Implemented

| HDFS Concept | This Implementation |
|---|---|
| Block Size | 64 KB (configurable via `BLOCK_SIZE` in source) |
| NameNode | Metadata JSON files in `storage/metadata/` |
| DataNode | Encrypted block files in `storage/blocks/` |
| Block ID | `<fileId>_blk<0000>` format |
| Checksum | SHA-256 per file, SHA-256 prefix per block |
| Replication | Single-node (extend by adding block copy logic) |

---

## ⚙ Configuration

| Environment Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server port |
| `CLOUD_SECRET` | `saas-cloud-lab-secret-2024` | Encryption master password |

Change the secret in `.vscode/launch.json` or set it in your shell:
```bash
CLOUD_SECRET=my-strong-secret npm start
```

---

## 🛠 Extending the Project

- **Replication**: Copy blocks to multiple DataNode directories/hosts
- **Larger blocks**: Change `BLOCK_SIZE` constant (e.g., `4 * 1024 * 1024` for 4 MB)
- **User authentication**: Add JWT middleware
- **Distributed nodes**: Run multiple instances, update NameNode to track node assignments

---

## 📋 Dependencies

- `express` — HTTP server
- `multer` — Multipart file upload parsing
- `cors` — Cross-Origin Resource Sharing
- Node.js built-in: `crypto` (AES-256-GCM), `fs`, `path`
