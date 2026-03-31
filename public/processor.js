/**
 * processor.js — AudioWorklet Processor
 *
 * This file runs on the browser's dedicated audio rendering thread (NOT the main thread).
 * Its job: capture raw Float32 mic samples → downsample to 16kHz → convert to Int16 PCM
 * → batch into chunks → post to the main thread for WebSocket transmission.
 *
 * The Gemini Live API requires:  16-bit PCM, 16kHz, mono, little-endian.
 * Browsers typically capture at 44100Hz or 48000Hz, so we must resample.
 */
class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();

        // Internal ring buffer to accumulate samples before sending a batch.
        // Sending too-small chunks causes poor streaming; too-large adds latency.
        // 2048 samples at 16kHz ≈ 128ms per batch — lower latency than 4096.
        this._bufferSize = 2048;
        this._buffer = new Int16Array(this._bufferSize);
        this._bufferIndex = 0;

        // ── Voice Isolation / Noise Gate State ────────────
        this._noiseThreshold = 0.015;     // Amplitude threshold to distinguish speech from background
        this._silenceTolerance = 50;      // Number of frames (~133ms) to wait before closing gate
        this._silenceFrames = 0;
        this._isSpeaking = false;
    }

    /**
     * process() is called by the audio engine every ~128 samples (one render quantum).
     * @param {Float32Array[][]} inputs - inputs[0][0] is the mono mic channel
     */
    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0] || input[0].length === 0) return true; // keep processor alive

        const sourceSamples = input[0]; // Float32Array, at the AudioContext sample rate
        
        // ── Voice Isolation Filter (Dynamic Noise Gate) ────────
        // Calculate the Root Mean Square (RMS) energy of this frame
        let sumSquares = 0;
        for (let i = 0; i < sourceSamples.length; i++) {
            sumSquares += sourceSamples[i] * sourceSamples[i];
        }
        const rms = Math.sqrt(sumSquares / sourceSamples.length);

        if (rms > this._noiseThreshold) {
            this._isSpeaking = true;
            this._silenceFrames = 0; // Reset silence counter
        } else {
            this._silenceFrames++;
            if (this._silenceFrames > this._silenceTolerance) {
                this._isSpeaking = false; // Isolate background
            }
        }

        const sourceSampleRate = globalThis.sampleRate; // e.g. 48000
        const targetSampleRate = 16000;

        // ── Downsample: pick every Nth sample (linear interpolation) ──────────
        // For 48kHz → 16kHz, ratio = 3. For 44.1kHz → 16kHz, ratio ≈ 2.75625.
        const ratio = sourceSampleRate / targetSampleRate;

        for (let i = 0; i < sourceSamples.length; i++) {
            // Only keep samples that correspond to target rate positions
            if (Math.floor(i / ratio) !== Math.floor((i - 1) / ratio) || i === 0) {
                
                // ── Mute background noise if not speaking ─────────────────────
                let floatSample = this._isSpeaking ? sourceSamples[i] : 0;

                // ── Convert Float32 [-1, 1] → Int16 [-32768, 32767] ───────────
                floatSample = Math.max(-1, Math.min(1, floatSample));
                const int16Sample = floatSample < 0
                    ? floatSample * 32768
                    : floatSample * 32767;

                this._buffer[this._bufferIndex++] = Math.round(int16Sample);

                // ── When our buffer is full, post it to the main thread ────────
                if (this._bufferIndex >= this._bufferSize) {
                    // Slice a copy — the buffer is reused each cycle
                    this.port.postMessage(this._buffer.slice(0));
                    this._bufferIndex = 0;
                }
            }
        }

        return true; // Return true to keep the processor alive
    }
}

registerProcessor('pcm-processor', PCMProcessor);
