# 📝 rdtlTranscript — AI Transcription

A **TurboScribe-inspired transcription app** powered by [Groq](https://groq.com) Whisper.  
Drag-and-drop audio or video files and get accurate, timestamped transcriptions in seconds — **no GPU required**.

![Python](https://img.shields.io/badge/Python-3.12-blue) ![FastAPI](https://img.shields.io/badge/FastAPI-latest-teal) ![Docker](https://img.shields.io/badge/Docker-ready-blue) ![Groq](https://img.shields.io/badge/Groq-Whisper-purple) ![Port](https://img.shields.io/badge/Port-6133-orange) ![Unraid](https://img.shields.io/badge/Unraid-7.2.2-red)

---

## ✨ Features

- 🎵 **Audio & Video** — MP3, MP4, WAV, M4A, WEBM, OGG, FLAC, MKV, MOV, AVI and more
- ⚡ **Blazing fast** — Groq delivers Whisper at up to 300× real-time speed
- 🌍 **25+ languages** — Auto-detect or manually specify the language
- 🕐 **Timestamps** — Segment-level time codes in every result
- 📤 **Export formats** — TXT, SRT, VTT, TSV, JSON
- 📋 **Local history** — All transcriptions stored in a local SQLite database
- 🐳 **Docker-ready** — Single container, zero external dependencies
- 📱 **Responsive UI** — Clean dark interface, works on desktop and mobile
- 🔒 **Self-hosted** — Your files never leave your server

---

## 🚀 Quick Start (Local Development)

```bash
# 1. Clone & create virtualenv
git clone https://github.com/hvcmartins/transcript2
cd transcript2
python -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Set your Groq API key
cp .env.example .env
# Edit .env and set GROQ_API_KEY=your_key

# 4. Run
uvicorn main:app --port 6133 --reload
# Open http://localhost:6133
```

Get a free Groq API key at **https://console.groq.com** — the free tier is very generous.

---

## 🖥️ Unraid Setup — Step by Step

> Tested on **Unraid 7.2.2**. Port used: **6133**.

---

### Method 1: Unraid Docker GUI (Recommended for Beginners)

This method builds the image directly on your Unraid server.

#### Step 1 — SSH into your Unraid server

Open a terminal or use the Unraid Terminal plugin:
```bash
ssh root@YOUR-UNRAID-IP
```

#### Step 2 — Create app directory and copy project files

```bash
mkdir -p /mnt/user/appdata/rdtlTranscript
```

Clone (or copy) the project files to your Unraid server:
```bash
cd /mnt/user/appdata/rdtlTranscript
git clone https://github.com/hvcmartins/transcript2 .
```

#### Step 3 — Build the Docker image

```bash
cd /mnt/user/appdata/rdtlTranscript
docker build -t rdtltranscript:latest .
```

Wait for the build to complete (~2–3 minutes the first time).

#### Step 4 — Add container via Unraid Docker GUI

1. Open the **Unraid Web UI** → click the **Docker** tab
2. Click **"Add Container"**
3. Fill in the fields:

| Field | Value |
|-------|-------|
| **Name** | `rdtlTranscript` |
| **Repository** | `rdtltranscript:latest` |
| **Network Type** | `Bridge` |
| **Console shell command** | `Shell` |
| **Extra Parameters** | `--restart=unless-stopped` |

#### Step 5 — Add Port Mapping

Click **"Add another Path, Port, Variable, Label or Device"** → select **Port**:

| Field | Value |
|-------|-------|
| Name | `WebUI` |
| Container Port | `6133` |
| Host Port | `6133` |
| Protocol | `TCP` |

#### Step 6 — Add Environment Variables

Click **"Add another Path, Port, Variable…"** → select **Variable** for each:

| Key | Value | Notes |
|-----|-------|-------|
| `GROQ_API_KEY` | `your_groq_api_key` | **Required** — get at console.groq.com |
| `PORT` | `6133` | Must match container port |
| `HOST` | `0.0.0.0` | Bind to all interfaces |
| `UPLOAD_DIR` | `/app/uploads` | Inside container |
| `DATA_DIR` | `/app/data` | Inside container |

#### Step 7 — Add Volume Mounts

Click **"Add another Path…"** → select **Path** for each:

| Config Type | Name | Container Path | Host Path | Access Mode |
|-------------|------|----------------|-----------|-------------|
| Path | Uploads | `/app/uploads` | `/mnt/user/appdata/rdtlTranscript/uploads` | Read/Write |
| Path | Database | `/app/data` | `/mnt/user/appdata/rdtlTranscript/data` | Read/Write |

#### Step 8 — Apply & Launch

1. Click **"Apply"** — Unraid will start the container automatically
2. Wait ~10 seconds for startup
3. Open your browser: **`http://YOUR-UNRAID-IP:6133`**

---

### Method 2: Docker Compose (via SSH)

If you prefer compose, SSH into your server and run:

```bash
mkdir -p /mnt/user/appdata/rdtlTranscript
cd /mnt/user/appdata/rdtlTranscript
git clone https://github.com/hvcmartins/transcript2 .

# Create your .env file
cat > .env << 'EOF'
GROQ_API_KEY=your_groq_api_key_here
PORT=6133
HOST=0.0.0.0
UPLOAD_DIR=/app/uploads
DATA_DIR=/app/data
EOF

# Build and start
docker compose up -d --build
```

Access the app at **`http://YOUR-UNRAID-IP:6133`**

To view logs:
```bash
docker logs -f rdtlTranscript
```

---

### Method 3: Unraid Community Applications XML Template

1. In the **Unraid Web UI** → **Docker** tab → **Add Container**
2. Scroll to the bottom and click **"XML View"**
3. Clear the default XML and paste the contents of [`unraid-template.xml`](./unraid-template.xml) from this repo
4. Fill in your `GROQ_API_KEY` value in the `GROQ_API_KEY` variable field
5. Click **Apply**

> **Note:** You still need to build the image first (Method 1 Step 3) since this app isn't on Docker Hub.

---

### Updating rdtlTranscript on Unraid

```bash
cd /mnt/user/appdata/rdtlTranscript
git pull origin main
docker build -t rdtltranscript:latest .
docker restart rdtlTranscript
```

---

### Troubleshooting on Unraid

| Problem | Solution |
|---------|----------|
| Container won't start | Check logs: `docker logs rdtlTranscript` |
| Port conflict | Change host port from `6133` to another free port |
| `GROQ_API_KEY` not set | Check your environment variables in Docker settings |
| File upload fails | Ensure `/mnt/user/appdata/rdtlTranscript/uploads` exists and has write permissions |
| Database error | Ensure `/mnt/user/appdata/rdtlTranscript/data` exists and is writable |
| Build fails | Run `apk update` or check internet access from the build context |

---

## 🔧 Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | *(required)* | Your Groq API key from [console.groq.com](https://console.groq.com) |
| `PORT` | `6133` | HTTP port the app listens on |
| `HOST` | `0.0.0.0` | Bind address |
| `UPLOAD_DIR` | `/app/uploads` | Directory for uploaded audio/video files |
| `DATA_DIR` | `/app/data` | Directory for the SQLite database |

---

## 📁 Supported File Formats

| Type | Formats |
|------|---------|
| Audio | MP3, WAV, M4A, FLAC, OGG, OPUS, AAC, WEBM |
| Video | MP4, MKV, MOV, AVI, WMV, WEBM, 3GP |
| Max size | **25 MB** (Groq API limit) |

---

## 📤 Export Formats

| Format | Description |
|--------|-------------|
| `.txt` | Plain text transcript |
| `.srt` | SubRip subtitles (for video players) |
| `.vtt` | WebVTT subtitles (for browsers/HTML5) |
| `.tsv` | Tab-separated values with timestamps |
| `.json` | Full JSON with text, segments, and word-level data |

---

## 🏗️ Architecture

```
rdtlTranscript/
├── main.py                    # FastAPI app + WebSocket server (port 6133)
├── routers/
│   ├── transcriptions.py      # Upload, list, get, delete endpoints
│   └── exports.py             # TXT, SRT, VTT, TSV, JSON export
├── services/
│   ├── groq_service.py        # Groq Whisper API wrapper
│   └── database.py            # SQLite via Python built-in sqlite3
├── public/                    # Vanilla JS frontend (no build step)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── requirements.txt           # Python dependencies
├── Dockerfile                 # Python 3.12-slim, port 6133
├── docker-compose.yml
├── unraid-template.xml        # Unraid Community Applications template
└── .env.example
```

---

## 🔑 Groq Whisper Models

| Model ID | Speed | Accuracy | Notes |
|----------|-------|----------|-------|
| `whisper-large-v3-turbo` | ⚡ Fastest | ★★★★ | Default, best balance |
| `whisper-large-v3` | ⏱ Medium | ★★★★★ | Most accurate |
| `distil-whisper-large-v3-en` | ⚡⚡ Ultrafast | ★★★ | English only |

---

## License

MIT
