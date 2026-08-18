// src/services/transcription.js
const { OpenAI, toFile } = require('openai');

// Initialize with your API key from .env
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
});

async function transcribeVideoBuffer(videoBuffer) {
    try {
        // Convert the raw memory buffer into a File-like object OpenAI can read
        // We name it 'video.mp4' so Whisper knows how to decode the audio track
        const file = await toFile(videoBuffer, 'video.mp4');

        const response = await openai.audio.transcriptions.create({
            file: file,
            model: 'whisper-1',
            response_format: 'text', // Returns raw string instead of a heavy JSON object
            prompt: 'Please transcribe this Instagram video. It may contain slang or music.'
        });

        // If the video is just music or silent, Whisper sometimes returns empty or "[Music]"
        if (!response || response.trim() === "" || response.includes("[Music]")) {
            return null;
        }

        return response.trim();
    } catch (error) {
        console.error("[OpenAI Error]:", error.message);
        throw new Error("Failed to transcribe video using AI.");
    }
}

module.exports = { transcribeVideoBuffer };