# Voice AI Assistant — Powered by Gemini Live

A real-time, low-latency conversational AI voice bot that uses the **Google Gemini Multimodal Live API** (`gemini-2.5-flash-native-audio-preview`). It allows users to talk seamlessly to an AI assistant just like a real phone call, featuring automatic voice activity detection, barge-in (interrupting the AI), and live transcriptions.

### 🛠️ Tech Stack
- **Frontend**: Vanilla JavaScript, HTML5, CSS3 (Glassmorphism UI)
- **Audio Processing**: Web Audio API (AudioContext, AudioWorklet), webkitSpeechRecognition
- **Backend**: Node.js, Express.js
- **Real-time Communication**: WebSockets (`ws`)
- **AI Engine**: Google Gemini Multimodal Live API

---

## 🏗️ Architecture & Workflow

This project is built using a purely native Web infrastructure with no heavy frameworks. Here is how the audio data flows from your microphone to Google's servers and back:

### 1. The Frontend (Browser)
- **Microphone Capture**: The browser asks for microphone access using `getUserMedia()`. 
- **Audio downsampling (`processor.js`)**: Browsers record at 44.1kHz or 48kHz, but Gemini requires strict **16kHz, 16-bit PCM** mono audio. We use a custom Web Audio API `AudioWorklet` to dynamically downsample the microphone input and strip background noise using an internal noise gate.
- **WebSocket Streaming (`script.js`)**: The downsampled audio chunks (ArrayBuffers) are sent to the backend server over a persistent WebSocket connection.
- **Live Transcriptions**: We run `webkitSpeechRecognition` in the background purely to show the user's spoken words on the UI as they talk.

### 2. The Backend (`server.js`)
- **Node.js Express & WS**: The server hosts the frontend static files and opens a WebSocket Server (`ws`) on port 3000.
- **Bridging to Gemini**: When a user connects, the server opens a secure WebSocket (`wss://`) directly to Google's Generative Language API using your `GEMINI_API_KEY`.
- **Relaying Audio**: As binary audio chunks arrive from the browser, the backend wraps them in Base64 `realtime_input` JSON messages and fires them to Gemini.

### 3. The AI Response & Playback
- **Gemini's Output**: Gemini natively understands the audio and generates an audio response using the prebuilt voice "Charon". It streams this back to our backend as base64-encoded **24kHz PCM** chunks.
- **Relay to Browser**: The backend unpackages that Base64 audio into raw binary Buffer and sends it down the WebSocket to the browser.
- **Gapless Playback**: The frontend receives the binary audio and converts it to `Float32Array`. Crucially, it schedules these blocks using a dedicated 24kHz `AudioContext` timeline to ensure gapless, stutter-free playback without audio drift. If the user interrupts the AI (barge-in), the playback queue is instantly flushed.

---

## 🚀 Features
* **Completely Hands-Free**: Start the mic once and converse normally. Voice Activity Detection (VAD) automatically knows when you finish speaking.
* **Barge-in Support**: If the AI is giving a long answer, you can just start speaking to cut it off.
* **Glassmorphism UI**: Beautiful, modern styling (`style.css`) with dynamic mic ripple animations and a canvas-based responsive audio waveform visualizer.

---

## 💻 Local Setup

1. **Clone the repository** (or download the folder).
2. **Install dependencies**:
   ```bash
   npm install
   ```
3. **Environment Setup**:
   Create a `.env` file in the root directory and add your Google API key:
   ```env
   GEMINI_API_KEY=your_gemini_api_key_here
   ```
4. **Run the server**:
   ```bash
   npm run dev
   ```
5. **Open your browser**:
   Navigate to `http://localhost:3000`.

> **Important**: Browsers strictly restrict microphone access. If deploying this application to the cloud, it must be hosted on an `https://` secure context, or the microphone will be permanently blocked by Chrome/Safari.
