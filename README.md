# 🎙️ Transcribify — AI Transcription

A **TurboScribe clone** powered by [Groq](https://groq.com) Whisper. Drag-and-drop audio/video files and get accurate transcriptions in seconds — no GPU required.

![Node.js](https://img.shields.io/badge/Node.js-24-green) ![Docker](https://img.shields.io/badge/Docker-ready-blue) ![Groq](https://img.shields.io/badge/Groq-Whisper-purple)

---

## Features

- 🎵 **Audio & Video** — MP3, MP4, WAV, M4A, WEBM, OGG, FLAC, MKV, MOV, AVI and more
- ⚡ **Blazing fast** — Groq delivers Whisper at up to 300x real-time speed
- 🌍 **25+ languages** — Auto-detect or specify the language
- 🕐 **Timestamps** — Segment-level time codes included
- 📤 **Export formats** — TXT, SRT, VTT, TSV, JSON
- 📋 **History** — All past transcriptions stored locally
- 🐳 **Docker-ready** — Single container, zero dependencies
- 📱 **Responsive UI** — Works on desktop and mobile

---

## Quick Start (Local)

```bash
# 1. Clone & install
git clone https://github.com/youruser/transcribify
cd transcribify
npm install

# 2. Set your Groq API key
cp .env.example .env
# Edit .env and add your GROQ_API_KEY

# 3. Run
npm start
# Open http://localhost:3000
```

Get a free Groq API key at **https://console.groq.com** — free tier is very generous.

---

## Docker (docker-compose)

```bash
# 1. Set your key
echo "GROQ_API_KEY=your_key_here" > .env

# 2. Build and start
docker-compose up -d

# 3. Open http://localhost:3000
```

---

## 🖥️ Unraid Setup — Step by Step

### Method 1: Docker Compose (Easiest)

1. **Install the "Docker Compose Manager" plugin** in Unraid  
   - Go to **Apps** → search `Docker Compose Manager` → Install

2. **SSH into your Unraid server**

3. **Create the project folder**
   ```bash
   mkdir -p /mnt/user/appdata/transcribify
   cd /mnt/user/appdata/transcribify
   ```

4. **Create the compose file**
   ```bash
   nano docker-compose.yml
   ```
   Paste:
   ```yaml
   version: "3.9"
   services:
     transcribify:
       image: transcribify:latest
       build:
         context: .
         dockerfile: Dockerfile
       container_name: transcribify
       restart: unless-stopped
       ports:
         - "3005:3000"
       environment:
         - GROQ_API_KEY=YOUR_API_KEY_HERE
         - PORT=3000
         - HOST=0.0.0.0
         - UPLOAD_DIR=/app/uploads
         - DATA_DIR=/app/data
       volumes:
         - /mnt/user/appdata/transcribify/uploads:/app/uploads
         - /mnt/user/appdata/transcribify/data:/app/data
   ```
   > Replace `YOUR_API_KEY_HERE` with your Groq key. Change `3005` to any free port on your server.

5. **Copy the project files**  
   Upload or clone the project files into `/mnt/user/appdata/transcribify/`

6. **Build and start**
   ```bash
   cd /mnt/user/appdata/transcribify
   docker-compose up -d --build
   ```

7. **Access the app** at `http://YOUR-UNRAID-IP:3005`

---

### Method 2: Unraid Docker Template (GUI)

1. **SSH into your Unraid server** and build the image first:
   ```bash
   mkdir -p /mnt/user/appdata/transcribify
   # Copy all project files here, then:
   cd /mnt/user/appdata/transcribify
   docker build -t transcribify:latest .
   ```

2. In the **Unraid Web UI**, go to **Docker** tab → **Add Container**

3. Fill in the form:

   | Field | Value |
   |-------|-------|
   | Name | `transcribify` |
   | Repository | `transcribify:latest` |
   | Network Type | `Bridge` |
   | Port (Host) | `3005` |
   | Port (Container) | `3000` |

4. Add **Environment Variables** (click "Add another Path, Port, Variable…" → Variable):

   | Key | Value |
   |-----|-------|
   | `GROQ_API_KEY` | `your_groq_api_key` |
   | `PORT` | `3000` |
   | `HOST` | `0.0.0.0` |
   | `UPLOAD_DIR` | `/app/uploads` |
   | `DATA_DIR` | `/app/data` |

5. Add **Volume Mounts** (click "Add another Path…" → Path):

   | Config Type | Name | Container Path | Host Path | Access Mode |
   |-------------|------|----------------|-----------|-------------|
   | Path | Uploads | `/app/uploads` | `/mnt/user/appdata/transcribify/uploads` | Read/Write |
   | Path | Database | `/app/data` | `/mnt/user/appdata/transcribify/data` | Read/Write |

6. Click **Apply** → container starts automatically

7. **Open** `http://YOUR-UNRAID-IP:3005`

---

### Method 3: Unraid Community Applications (Custom XML Template)

1. In the **Unraid Web UI**, go to **Docker** tab → **Add Container**
2. Click **"Template repositories"** → **"Add"** (paste nothing — we'll use the XML directly)
3. Scroll down and click **"XML View"** toggle
4. Paste this XML:

```xml
<?xml version="1.0"?>
<Container version="2">
  <Name>transcribify</Name>
  <Repository>transcribify:latest</Repository>
  <Registry/>
  <Network>bridge</Network>
  <Privileged>false</Privileged>
  <Support/>
  <Project>https://github.com/youruser/transcribify</Project>
  <Overview>TurboScribe clone powered by Groq Whisper AI. Transcribe audio and video files with timestamps and multiple export formats.</Overview>
  <Category>Productivity: MediaApp:</Category>
  <WebUI>http://[IP]:[PORT:3000]/</WebUI>
  <TemplateURL/>
  <Icon>https://cdn-icons-png.flaticon.com/512/4211/4211763.png</Icon>
  <ExtraParams>--restart=unless-stopped</ExtraParams>
  <PostArgs/>
  <CPUset/>
  <DateInstalled/>
  <DonateText/>
  <DonateLink/>
  <Description>TurboScribe clone — AI transcription powered by Groq Whisper. No GPU needed.</Description>
  <Networking>
    <Mode>bridge</Mode>
    <Publish>
      <Port>
        <HostPort>3005</HostPort>
        <ContainerPort>3000</ContainerPort>
        <Protocol>tcp</Protocol>
      </Port>
    </Publish>
  </Networking>
  <Data>
    <Volume>
      <HostDir>/mnt/user/appdata/transcribify/uploads</HostDir>
      <ContainerDir>/app/uploads</ContainerDir>
      <Mode>rw</Mode>
    </Volume>
    <Volume>
      <HostDir>/mnt/user/appdata/transcribify/data</HostDir>
      <ContainerDir>/app/data</ContainerDir>
      <Mode>rw</Mode>
    </Volume>
  </Data>
  <Environment>
    <Variable>
      <Value/>
      <Name>GROQ_API_KEY</Name>
      <Mode/>
    </Variable>
    <Variable>
      <Value>3000</Value>
      <Name>PORT</Name>
      <Mode/>
    </Variable>
    <Variable>
      <Value>0.0.0.0</Value>
      <Name>HOST</Name>
      <Mode/>
    </Variable>
    <Variable>
      <Value>/app/uploads</Value>
      <Name>UPLOAD_DIR</Name>
      <Mode/>
    </Variable>
    <Variable>
      <Value>/app/data</Value>
      <Name>DATA_DIR</Name>
      <Mode/>
    </Variable>
  </Environment>
</Container>
```

5. Fill in your `GROQ_API_KEY` value and click **Apply**

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `GROQ_API_KEY` | *(required)* | Your Groq API key from console.groq.com |
| `PORT` | `3000` | HTTP port the app listens on |
| `HOST` | `0.0.0.0` | Bind address |
| `UPLOAD_DIR` | `./uploads` | Directory for uploaded audio files |
| `DATA_DIR` | `./data` | Directory for the SQLite database |

---

## Supported File Formats

| Type | Formats |
|------|---------|
| Audio | MP3, WAV, M4A, FLAC, OGG, OPUS, AAC, WEBM |
| Video | MP4, MKV, MOV, AVI, WMV, WEBM, 3GP |
| Max size | **25 MB** (Groq API limit) |

---

## Export Formats

| Format | Description |
|--------|-------------|
| `.txt` | Plain text transcript |
| `.srt` | SubRip subtitles (for video players) |
| `.vtt` | WebVTT subtitles (for browsers/HTML5) |
| `.tsv` | Tab-separated values with timestamps |
| `.json` | Full JSON with text, segments, and words |

---

## Architecture

```
transcribify/
├── server.js          # Express + WebSocket server
├── routes/
│   ├── transcriptions.js  # Upload, list, get, delete
│   └── exports.js         # TXT, SRT, VTT, TSV, JSON
├── services/
│   ├── groq.js        # Groq Whisper API wrapper
│   └── database.js    # SQLite via better-sqlite3
├── middleware/
│   └── upload.js      # Multer file upload config
├── public/            # Static frontend (vanilla JS)
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
├── Dockerfile
└── docker-compose.yml
```

---

## License

MIT
