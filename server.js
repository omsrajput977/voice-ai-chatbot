import 'dotenv/config';
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Only the "native-audio" model family supports bidiGenerateContent (Live API)
const GEMINI_LIVE_MODEL = 'models/gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_LIVE_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${GEMINI_API_KEY}`;

if (!GEMINI_API_KEY) {
    console.error('🚨 GEMINI_API_KEY is not set in .env!');
    process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use((req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// We attach our WebSocketServer to a plain http.Server so Express and WS share port 3000
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

console.log(`\n🚀 Server starting on http://localhost:3000`);
console.log(`🤖 Using Gemini model: ${GEMINI_LIVE_MODEL}\n`);

// ─── Handle each browser client that connects ─────────────────────────────────
wss.on('connection', (browserWs) => {
    console.log('✅ Browser client connected');

    // ── 1. Open a fresh connection to the Gemini Live API for this client ──
    const geminiWs = new WebSocket(GEMINI_LIVE_URL);

    // ── 2. Send Gemini setup message as soon as the connection opens ────────
    geminiWs.on('open', () => {
        console.log('🔗 Connected to Gemini Live API');

        const setupMessage = {
            setup: {
                model: GEMINI_LIVE_MODEL,
                generation_config: {
                    // Request native audio output — the model speaks back directly
                    response_modalities: ['AUDIO'],
                    speech_config: {
                        voice_config: {
                            prebuilt_voice_config: {
                                voice_name: 'Charon' // Options: Aoede, Charon, Fenrir, Kore, Puck
                            }
                        }
                    }
                },
                // ── Voice Activity Detection (VAD) ─────────────────────────────
                // Gemini auto-detects when the user stops talking and responds
                // IMMEDIATELY — no manual endTurn button click required.
                // This eliminates the biggest source of latency in the old flow.
                realtimeInputConfig: {
                    automaticActivityDetection: {
                        disabled: false,                              // Enable built-in VAD
                        prefixPaddingMs: 20,               // Include 20ms before detected speech
                        silenceDurationMs: 400               // 400ms silence = end of turn (vs default ~1500ms)
                    }
                },
                // ── Gemini-side user transcript ────────────────────────────────
                // Let Gemini transcribe the user's speech directly — more
                // accurate and avoids depending on webkitSpeechRecognition.
                inputAudioTranscription: {},
                system_instruction: {
                    parts: [{
                        text: [
                            'You are a helpful, conversational voice assistant.',
                            'Speak directly and naturally to the user as if in a real conversation.',
                            'NEVER narrate your own actions (e.g. do not say "I am now responding to you...").',
                            'NEVER describe what you are doing (e.g. do not say "Acknowledging the greeting...").',
                            'NEVER explain your thought process.',
                            'Do NOT use markdown, bullet points, headers, or any formatting.',
                            'Keep responses concise and natural, like spoken conversation.',
                            'Just speak the answer directly.'
                        ].join(' ')
                    }]
                }
            } 
        };

        geminiWs.send(JSON.stringify(setupMessage));
        console.log('📤 Sent setup message to Gemini');
    });

    // ── 3. Relay messages from Gemini back to the browser ──────────────────
    geminiWs.on('message', (data) => {
        try {
            const msg = JSON.parse(data.toString());

            // A. Setup complete — notify browser the session is ready
            if (msg.setupComplete) {
                console.log('✅ Gemini setup complete — session ready');
                browserWs.send(JSON.stringify({ type: 'ready' }));
                return;
            }

            // B. Server content containing audio chunks
            if (msg.serverContent) {
                const { modelTurn, interrupted, turnComplete } = msg.serverContent;

                // B1. Barge-in / interruption — AI was cut off by user speech
                if (interrupted) {
                    console.log('⚡ Barge-in detected — telling browser to stop playback');
                    if (browserWs.readyState === WebSocket.OPEN) {
                        browserWs.send(JSON.stringify({ type: 'interrupt' }));
                    }
                    return;
                }

                // B2. Audio data parts — forward raw binary PCM to browser
                if (modelTurn?.parts) {
                    for (const part of modelTurn.parts) {
                        // IMPORTANT: Gemini Live API returns camelCase JSON — 'inlineData', NOT 'inline_data'
                        if (part.inlineData?.mimeType?.startsWith('audio/')) {
                            // Decode base64 PCM → raw binary Buffer and forward to browser as binary WS frame
                            const audioBuffer = Buffer.from(part.inlineData.data, 'base64');
                            console.log(`🎵 Forwarding audio chunk: ${audioBuffer.byteLength} bytes (${part.inlineData.mimeType})`);
                            if (browserWs.readyState === WebSocket.OPEN) {
                                browserWs.send(audioBuffer); // Raw binary — browser receives as ArrayBuffer
                            }
                        }
                        // Forward text transcript if present (AI response text)
                        if (part.text) {
                            console.log(`💬 AI transcript: "${part.text.substring(0, 60)}..."`);
                            if (browserWs.readyState === WebSocket.OPEN) {
                                browserWs.send(JSON.stringify({ type: 'transcript', text: part.text, role: 'ai' }));
                            }
                        }
                    }
                }

                // B3. Turn complete
                if (turnComplete) {
                    if (browserWs.readyState === WebSocket.OPEN) {
                        browserWs.send(JSON.stringify({ type: 'turnComplete' }));
                    }
                }
            }

            // C. User transcript (input_transcription)
            if (msg.inputTranscription?.text) {
                if (browserWs.readyState === WebSocket.OPEN) {
                    browserWs.send(JSON.stringify({ type: 'transcript', text: msg.inputTranscription.text, role: 'user' }));
                }
            }

        } catch (e) {
            // Gemini sometimes sends binary frames — ignore them here (already handled above)
        }
    });

    geminiWs.on('error', (err) => {
        console.error('❌ Gemini WebSocket error:', err.message);
        if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.send(JSON.stringify({ type: 'error', message: err.message }));
        }
    });

    geminiWs.on('close', (code, reason) => {
        console.log(`🔌 Gemini WS closed: ${code} — ${reason}`);
        if (browserWs.readyState === WebSocket.OPEN) {
            browserWs.close();
        }
    });

    // ── 4. Relay audio chunks from browser → Gemini ────────────────────────
    browserWs.on('message', (data, isBinary) => {
        if (geminiWs.readyState !== WebSocket.OPEN) return;

        if (isBinary) {
            // Raw PCM Int16 audio from the browser's AudioWorklet
            // Wrap in Gemini's realtime_input protocol message format
            const base64Audio = data.toString('base64');
            const realtimeMsg = {
                realtime_input: {
                    media_chunks: [{
                        mime_type: 'audio/pcm',   // 16-bit PCM, 16kHz, mono, little-endian
                        data: base64Audio
                    }]
                }
            };
            geminiWs.send(JSON.stringify(realtimeMsg));
        } else {
            // JSON control messages from browser (e.g. end-of-turn signal)
            try {
                const msg = JSON.parse(data.toString());
                if (msg.type === 'endTurn') {
                    // Gemini Live API uses camelCase JSON — clientContent / turnComplete (NOT snake_case).
                    // Sending the correct field name forces Gemini to generate its response immediately
                    // without waiting for a silence timeout, eliminating latency between turns.
                    geminiWs.send(JSON.stringify({ clientContent: { turnComplete: true } }));
                    console.log('📤 Sent turnComplete to Gemini — AI will respond now');
                }
            } catch (e) { /* ignore malformed */ }
        }
    });

    // ── 5. Cleanup when browser disconnects ────────────────────────────────
    browserWs.on('close', () => {
        console.log('👋 Browser client disconnected — closing Gemini session');
        if (geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });

    browserWs.on('error', (err) => {
        console.error('❌ Browser WebSocket error:', err.message);
    });
});

server.listen(3000, () => {
    console.log('🎙️  Voice AI is live at http://localhost:3000\n');
});
