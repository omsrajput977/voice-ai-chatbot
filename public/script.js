/**
 * script.js — Frontend: WebSocket client, mic capture, and audio playback
 *
 * Flow:
 *   1. Connect to backend via WebSocket on page load
 *   2. On mic button click: capture mic → AudioWorklet (PCM 16kHz) → send over WS
 *                           + parallel webkitSpeechRecognition for UI text display
 *   3. Receive binary audio from WS → decode Int16 PCM 24kHz → queue for playback
 *      via a DEDICATED 24kHz playback AudioContext (separate from 16kHz capture context)
 *   4. Handle barge-in (interrupt) signals → stop current playback immediately
 */

// ─── DOM References ────────────────────────────────────────────────────────────
const micBtn            = document.getElementById('mic-btn');
const statusText        = document.getElementById('status-text');
const messagesContainer = document.getElementById('messages-container');
const loadingIndicator  = document.getElementById('loading-indicator');
const canvas            = document.getElementById('visualizer');
const canvasCtx         = canvas ? canvas.getContext('2d') : null;

// ─── State ─────────────────────────────────────────────────────────────────────
let ws               = null;   // WebSocket to our Node.js backend
let captureContext   = null;   // AudioContext for MIC capture (runs at 16kHz)
let playbackContext  = null;   // SEPARATE AudioContext for AI audio playback (24kHz)
let micStream        = null;   // Raw MediaStream from getUserMedia
let workletNode      = null;   // AudioWorkletNode (PCM processor)
let sourceNode       = null;   // MediaStreamSourceNode (mic → worklet)
let analyserNode     = null;   // AnalyserNode for visual waveform
let isSessionReady   = false;  // True after Gemini setup handshake completes
let isRecording      = false;  // True while mic is actively streaming
let isMuted          = false;  // True when user has muted the mic (but stream stays open)
let recognition      = null;   // webkitSpeechRecognition instance (for UI display only)
let micStartedByVAD  = true;   // Mic is managed automatically (always-on, hands-free)

// ── Audio Playback Queue ───────────────────────────────────────────────────────
// KEY: Gemini outputs 24kHz PCM. The playbackContext MUST be created at 24kHz.
// Using a single shared context for both capture (16kHz) and playback (24kHz)
// causes silent resampling failures. Keep them strictly separate.
const OUTPUT_SAMPLE_RATE = 24000; // Gemini's output rate — do not change
let playbackQueue    = [];     // Array of AudioBuffers waiting to play
let isPlaying        = false;  // Whether the queue is currently draining
let nextPlayTime     = 0;      // Scheduled start time for the next audio buffer
let currentSources   = [];     // Track active AudioBufferSourceNodes for interrupt

// ─── 1. Connect WebSocket to Backend ──────────────────────────────────────────
function connectWebSocket() {
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${protocol}://${location.host}`);
    ws.binaryType = 'arraybuffer'; // Receive AI audio as raw ArrayBuffer

    ws.onopen = () => {
        console.log('🔗 WebSocket connected to backend');
        setStatus('Connecting to AI...');
    };

    ws.onmessage = (event) => {
        // ── Binary frame = raw AI audio (Int16 PCM at 24kHz) ──────────────────
        if (event.data instanceof ArrayBuffer) {
            handleIncomingAudio(event.data);
            return;
        }

        // ── Text frame = JSON control signal ──────────────────────────────────
        try {
            const msg = JSON.parse(event.data);

            switch (msg.type) {
                case 'ready':
                    // Gemini Live session fully initialized — auto-start mic (hands-free)
                    isSessionReady = true;
                    micBtn.disabled = false;
                    addMessage("Hello! I'm your AI voice assistant. Just start talking — I'll respond automatically.", 'ai');
                    // ── Auto-start mic immediately (like real Gemini Live) ─────────
                    startMic();
                    break;

                case 'transcript':
                    // Text transcript — Gemini sends BOTH user and AI transcripts
                    if (msg.role === 'ai') {
                        addMessage(msg.text, 'ai');
                    } else if (msg.role === 'user') {
                        // Gemini's inputAudioTranscription for the user's speech
                        addMessage(msg.text, 'user');
                    }
                    break;

                case 'interrupt':
                    // Gemini detected user speech mid-response → stop AI audio
                    console.log('⚡ Barge-in — flushing AI audio queue');
                    stopPlayback();
                    loadingIndicator.classList.add('hidden');
                    break;

                case 'turnComplete':
                    // AI finished its turn — mic is already on, just update status
                    loadingIndicator.classList.add('hidden');
                    setStatus(isMuted ? '🔇 Muted — tap to unmute' : 'Listening...');
                    break;

                case 'error':
                    console.error('❌ Server error:', msg.message);
                    setStatus('Error — check terminal');
                    break;

                default:
                    console.log('📩 Unknown message type:', msg.type);
            }
        } catch (e) {
            // Not valid JSON — ignore
        }
    };

    ws.onclose = () => {
        console.warn('🔌 WebSocket disconnected');
        isSessionReady = false;
        stopPlayback();          // reset nextPlayTime for the next session
        setStatus('Tap to reconnect');
        micBtn.disabled = false; // re-enable so user can click to reconnect
    };

    ws.onerror = (err) => {
        console.error('❌ WebSocket error:', err);
        setStatus('Connection error');
    };
}

// ─── 2A. webkitSpeechRecognition — UI transcript only ─────────────────────────
// We run this in PARALLEL with the PCM stream.
// Its sole job is to show the user's words in the chat UI.
// It does NOT send anything to the backend.
function setupSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
        console.warn('⚠️  webkitSpeechRecognition not available — user transcripts will not appear');
        return null;
    }

    const rec = new SpeechRecognition();
    rec.continuous       = true;  // Keep recognizing while mic is active
    rec.interimResults   = false; // Only show final results in chat
    rec.lang             = 'en-US';

    rec.onresult = (event) => {
        // Accumulate only the NEW final results added in this event
        for (let i = event.resultIndex; i < event.results.length; i++) {
            if (event.results[i].isFinal) {
                const text = event.results[i][0].transcript.trim();
                if (text) {
                    console.log('🗣️  User said:', text);
                    addMessage(text, 'user');
                }
            }
        }
    };

    rec.onerror = (event) => {
        // 'no-speech' and 'aborted' are normal — don't log those as errors
        if (event.error !== 'no-speech' && event.error !== 'aborted') {
            console.error('🎤 SpeechRecognition error:', event.error);
        }
    };

    // Auto-restart if Chrome stops recognition mid-session (happens after ~60s silence)
    // WHY setTimeout: Chrome fires onend BEFORE fully tearing down the internal session.
    // Calling rec.start() with zero delay throws InvalidStateError (silently caught),
    // which permanently kills STT. A 250ms gap lets Chrome reset before we restart.
    rec.onend = () => {
        if (isRecording && !isMuted) {
            setTimeout(() => {
                if (isRecording && !isMuted) { // re-check: user might have stopped mic during the delay
                    try { rec.start(); } catch (e) {
                        console.warn('🎤 STT restart failed:', e.message);
                    }
                }
            }, 250);
        }
    };

    return rec;
}

// ─── 2B. Mic Button — Mute / Unmute Toggle ───────────────────────────────────
// In always-on mode the mic stays open continuously (like Gemini Live).
// The button now MUTES / UNMUTES the stream instead of starting/stopping it.
// Clicking while disconnected will reconnect and restart the session.
micBtn.disabled = true;

micBtn.addEventListener('click', async () => {
    // ── Reconnect if the WebSocket is closed or closing ───────────────────────
    if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
        console.log('🔄 Reconnecting WebSocket...');
        setStatus('Reconnecting...');
        micBtn.disabled = true;
        isMuted = false;
        stopPlayback();
        connectWebSocket();
        return; // Wait for 'ready' signal — mic auto-starts then
    }

    if (!isSessionReady) return;

    if (!isRecording) {
        // Mic not yet started (shouldn't normally happen in always-on mode)
        await startMic();
        return;
    }

    // ── Toggle mute ───────────────────────────────────────────────────────────
    isMuted = !isMuted;

    if (isMuted) {
        // ── MUTE: Cut audio flow at BOTH graph AND track level ────────────────
        //
        // Layer 1 — Disconnect sourceNode → workletNode at the Web Audio graph.
        // This stops PCM samples from ever reaching the worklet, so it posts
        // no more messages and the onmessage guard never even fires.
        if (sourceNode && workletNode) {
            try { sourceNode.disconnect(workletNode); } catch (e) {}
        }
        //
        // Layer 2 — Disable the raw MediaStreamTrack so the OS mic indicator
        // light turns off (good UX signal that we're truly silent).
        if (micStream) micStream.getTracks().forEach(t => t.enabled = false);

        // Layer 3 — Stop UI speech recognition
        if (recognition) {
            try { recognition.stop(); } catch (e) {}
        }

        micBtn.classList.remove('recording');
        micBtn.classList.add('muted');
        setStatus('🔇 Muted — tap to unmute');

    } else {
        // ── UNMUTE: Restore audio flow in reverse order ───────────────────────
        //
        // Layer 2 — Re-enable track first so audio actually flows into the graph.
        if (micStream) micStream.getTracks().forEach(t => t.enabled = true);
        //
        // Layer 1 — Reconnect sourceNode → workletNode so samples reach the worklet.
        if (sourceNode && workletNode) {
            try { sourceNode.connect(workletNode); } catch (e) {}
        }

        // Layer 3 — Restart UI speech recognition
        if (recognition) {
            try { recognition.start(); } catch (e) {}
        }

        micBtn.classList.add('recording');
        micBtn.classList.remove('muted');
        setStatus('Listening...');
    }
});

async function startMic() {
    try {
        // ── Step 1: Request microphone access ─────────────────────────────────
        micStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                channelCount:    1,
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl:  true
            }
        });

        // ── Step 2: Create the dedicated CAPTURE AudioContext ─────────────────
        // Must be created inside a user gesture (this click handler) to avoid
        // Autoplay policy suspension. We request 16kHz for Gemini's input format.
        captureContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: 16000  // Request 16kHz; worklet handles downsampling if needed
        });

        // Explicitly resume — critical to bypass Chrome's autoplay policy
        await captureContext.resume();
        console.log(`🎙️  Capture AudioContext: ${captureContext.sampleRate}Hz, state: ${captureContext.state}`);

        // ── Step 3: Create/resume the DEDICATED PLAYBACK AudioContext at 24kHz ──
        // CRITICAL: This MUST be a separate context from captureContext.
        // If we use a 16kHz context to play 24kHz audio, the samples are misaligned
        // and the audio either plays silently or at the wrong speed.
        if (!playbackContext) {
            playbackContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: OUTPUT_SAMPLE_RATE  // 24kHz — matches Gemini output exactly
            });
        }
        // Resume inside this gesture event so playback isn't blocked by autoplay policy
        if (playbackContext.state === 'suspended') {
            await playbackContext.resume();
        }
        console.log(`🔊 Playback AudioContext: ${playbackContext.sampleRate}Hz, state: ${playbackContext.state}`);

        // ── Step 4: Load the PCM AudioWorklet and wire up the mic pipeline ─────
        await captureContext.audioWorklet.addModule('processor.js');
        sourceNode   = captureContext.createMediaStreamSource(micStream);
        workletNode  = new AudioWorkletNode(captureContext, 'pcm-processor');
        analyserNode = captureContext.createAnalyser();
        analyserNode.fftSize = 256;

        sourceNode.connect(workletNode);
        sourceNode.connect(analyserNode);
        // Do NOT connect workletNode to destination — that would create mic echo

        // ── Step 5: Stream PCM batches from the worklet over WebSocket ─────────
        workletNode.port.onmessage = (e) => {
            // CRITICAL: Do NOT send audio when muted.
            // isMuted is checked here (not just at track level) because disabling
            // a MediaStreamTrack still allows the worklet to post silence frames.
            // Without this guard, Gemini's VAD keeps receiving audio and can
            // still pick up residual / ambient sound through the muted track.
            if (isMuted) return;
            if (ws && ws.readyState === WebSocket.OPEN) {
                // e.data = Int16Array of 16kHz mono PCM — send as raw binary
                ws.send(e.data.buffer);
            }
        };

        // ── Step 6: Start parallel speech recognition for UI transcript ────────
        recognition = setupSpeechRecognition();
        if (recognition) {
            try { recognition.start(); } catch (e) { /* already started */ }
        }

        isRecording = true;
        micBtn.classList.add('recording');
        setStatus('Listening...');

        // Stop any current AI audio (barge-in from client perspective)
        stopPlayback();

        // Start visual waveform on the capture context analyser
        drawWaveform();

    } catch (err) {
        console.error('❌ Could not start microphone:', err);
        setStatus('Mic access denied');
    }
}

function stopMic() {
    // Full teardown — only called on disconnect / error, NOT on button click.
    // In always-on mode the button mutes instead of calling this.

    // ── 1. Stop the parallel speech recognizer ────────────────────────────────
    if (recognition) {
        try { recognition.stop(); } catch (e) {}
        recognition = null;
    }

    // ── 2. Tear down the capture pipeline ─────────────────────────────────────
    if (workletNode) { workletNode.disconnect(); workletNode = null; }
    if (sourceNode)  { sourceNode.disconnect();  sourceNode  = null; }
    if (micStream)   { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (captureContext) {
        captureContext.close().catch(() => {});
        captureContext = null;
    }

    isRecording = false;
    isMuted = false;
    micBtn.classList.remove('recording');
    micBtn.classList.remove('muted');
}

// ─── 3. AI Audio Playback (24kHz Int16 PCM → AudioContext) ────────────────────

/**
 * handleIncomingAudio
 *
 * Receives a raw binary ArrayBuffer of Int16 16-bit PCM at 24kHz from the server.
 * The server has already base64-decoded Gemini's response and forwarded raw bytes.
 *
 * Strict decoding pipeline:
 *   ArrayBuffer → Int16Array → Float32Array (÷ 32768) → AudioBuffer @24kHz → playback queue
 */
function handleIncomingAudio(arrayBuffer) {
    loadingIndicator.classList.add('hidden');

    try {
        // ── Guard: skip empty frames ───────────────────────────────────────────
        if (!arrayBuffer || arrayBuffer.byteLength === 0) {
            console.warn('⚠️  Received empty audio frame — skipping');
            return;
        }

        // ── Ensure dedicated 24kHz playback AudioContext exists ────────────────
        if (!playbackContext) {
            playbackContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: OUTPUT_SAMPLE_RATE   // 24000 Hz — must match Gemini output
            });
            console.log(`🔊 Created playback AudioContext at ${playbackContext.sampleRate}Hz`);
        }

        if (playbackContext.state === 'suspended') {
            playbackContext.resume();
        }

        // ── STRICT DECODE: ArrayBuffer → Int16Array → Float32Array ────────────
        // Gemini sends 16-bit signed PCM (little-endian).
        // The server decodes base64 → raw bytes and forwards as binary WS frame.
        // We read those bytes as Int16, then linearly scale to Float32 [-1.0, 1.0].
        // Dividing by 32768 (not 32767) correctly handles the full signed int16 range.
        const int16Array  = new Int16Array(arrayBuffer);
        const sampleCount = int16Array.length;

        if (sampleCount === 0) {
            console.warn('⚠️  Int16Array is empty after conversion — skipping');
            return;
        }

        const float32Array = new Float32Array(sampleCount);
        for (let i = 0; i < sampleCount; i++) {
            float32Array[i] = int16Array[i] / 32768;   // Strict: always divide by 32768
        }

        // ── Wrap in AudioBuffer at exactly OUTPUT_SAMPLE_RATE (24000) ──────────
        // CRITICAL: sampleRate passed to createBuffer MUST match the AudioContext's
        // sampleRate, otherwise copyToChannel silently resamples and breaks playback.
        const audioBuffer = playbackContext.createBuffer(
            1,                   // Channels: Mono
            sampleCount,
            OUTPUT_SAMPLE_RATE   // 24000 — identical to playbackContext.sampleRate
        );
        audioBuffer.copyToChannel(float32Array, 0);

        const durationMs = (sampleCount / OUTPUT_SAMPLE_RATE * 1000).toFixed(1);
        console.log(`🎵 Audio chunk: ${sampleCount} samples (~${durationMs}ms) | ctx: ${playbackContext.state} @${playbackContext.sampleRate}Hz`);

        // ── Enqueue and schedule ───────────────────────────────────────────────
        // Always call drainPlaybackQueue — not just when !isPlaying.
        // If already playing, drainPlaybackQueue will pick up this new buffer
        // via the nextPlayTime pointer and schedule it gaplessly.
        playbackQueue.push(audioBuffer);
        drainPlaybackQueue();

    } catch (err) {
        console.error('❌ handleIncomingAudio FAILED:', err.message);
        console.error('   Buffer    :', arrayBuffer?.byteLength, 'bytes');
        console.error('   Context   :', playbackContext?.state, '@', playbackContext?.sampleRate, 'Hz');
    }
}


/**
 * drainPlaybackQueue
 *
 * Schedules as many buffered AudioBuffers as it can right now using the
 * Web Audio clock (nextPlayTime) for perfect gapless playback.
 *
 * KEY FIX: This is called from BOTH handleIncomingAudio AND from each
 * source's onended callback. That guarantees chunks that arrive while
 * a previous chunk is still playing get scheduled immediately instead
 * of being stranded in the queue.
 */
function drainPlaybackQueue() {
    if (!playbackContext || playbackQueue.length === 0) {
        // Nothing left to schedule — check if we can mark idle
        if (currentSources.length === 0) {
            isPlaying    = false;
            nextPlayTime = 0;
        }
        return;
    }

    isPlaying = true;

    // Drain ALL currently-pending buffers in one pass, scheduling them back-to-back
    while (playbackQueue.length > 0) {
        const buffer = playbackQueue.shift();

        try {
            const source = playbackContext.createBufferSource();
            source.buffer = buffer;
            source.connect(playbackContext.destination);

            // ── Gapless scheduling ─────────────────────────────────────────────
            // nextPlayTime is the end of the last scheduled chunk.
            // If we've fallen behind (e.g. after a pause/interrupt), snap to now.
            const startTime = Math.max(playbackContext.currentTime, nextPlayTime);
            source.start(startTime);

            // Advance the schedule pointer by this chunk's exact duration
            nextPlayTime = startTime + buffer.duration;
            currentSources.push(source);

            source.onended = () => {
                currentSources = currentSources.filter(s => s !== source);

                if (playbackQueue.length > 0) {
                    // More chunks have arrived while this one was playing — schedule them
                    drainPlaybackQueue();
                } else if (currentSources.length === 0) {
                    // Queue empty and no active sources — truly idle
                    isPlaying    = false;
                    nextPlayTime = 0;
                    setStatus(isRecording ? 'Listening...' : 'Tap to Speak');
                }
            };
        } catch (err) {
            console.error('❌ drainPlaybackQueue: failed to schedule buffer:', err);
        }
    }
}

/**
 * stopPlayback — immediately flush queued buffers and stop all active nodes.
 * Called on barge-in signal from server and at mic start.
 */
function stopPlayback() {
    playbackQueue = [];
    isPlaying     = false;
    nextPlayTime  = 0;

    for (const source of currentSources) {
        try { source.stop(); } catch (e) { /* already ended */ }
    }
    currentSources = [];
}

// ─── 4. UI Helpers ─────────────────────────────────────────────────────────────

function setStatus(text) {
    if (statusText) statusText.textContent = text;
}

function addMessage(text, role) {
    if (!text || !text.trim()) return;

    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message', role === 'user' ? 'user' : 'ai');

    const avatar = document.createElement('div');
    avatar.classList.add('avatar');
    avatar.textContent = role === 'user' ? '👤' : '✨';

    const content = document.createElement('div');
    content.classList.add('message-content');

    text.split('\n').forEach(line => {
        if (line.trim()) {
            const p = document.createElement('p');
            p.textContent = line;
            content.appendChild(p);
        }
    });

    messageDiv.appendChild(avatar);
    messageDiv.appendChild(content);
    messagesContainer.appendChild(messageDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

// ─── 5. Canvas Waveform Visualizer ─────────────────────────────────────────────

function drawWaveform() {
    if (!canvas || !canvasCtx || !analyserNode || !isRecording) return;

    requestAnimationFrame(drawWaveform);

    const bufferLength = analyserNode.frequencyBinCount;
    const dataArray    = new Uint8Array(bufferLength);
    analyserNode.getByteTimeDomainData(dataArray);

    canvasCtx.clearRect(0, 0, canvas.width, canvas.height);

    const gradient = canvasCtx.createLinearGradient(0, 0, canvas.width, 0);
    gradient.addColorStop(0,   '#7b2cbf');
    gradient.addColorStop(0.5, '#4cc9f0');
    gradient.addColorStop(1,   '#7b2cbf');

    canvasCtx.lineWidth   = 2;
    canvasCtx.strokeStyle = gradient;
    canvasCtx.beginPath();

    const sliceWidth = canvas.width / bufferLength;
    let x = 0;

    for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * canvas.height) / 2;
        if (i === 0) canvasCtx.moveTo(x, y);
        else         canvasCtx.lineTo(x, y);
        x += sliceWidth;
    }

    canvasCtx.lineTo(canvas.width, canvas.height / 2);
    canvasCtx.stroke();
}

// ─── Init ───────────────────────────────────────────────────────────────────────
connectWebSocket();
