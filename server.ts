import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { orchestrator } from './src/server/orchestrator.js';
import { sharedMemory } from './src/server/shared-memory.js';
import { getGeminiClient, GEMINI_MODEL_TTS } from './src/server/gemini.js';
import { Modality } from '@google/genai';

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '10mb' }));

  // API Routes
  app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Orchestrator Event Dispatcher
  app.post('/api/orchestrator/event', async (req, res) => {
    const { eventType, payload } = req.body;
    if (!eventType) {
      return res.status(400).json({ success: false, message: 'eventType is required' });
    }

    const result = await orchestrator.handleEvent(eventType, payload || {});
    res.json(result);
  });

  // Live State Telemetry Endpoint (for initial load / polling)
  app.get('/api/live-state', (req, res) => {
    res.json({
      success: true,
      candidateProfile: sharedMemory.getCandidateProfile(),
      activeSession: sharedMemory.getActiveSession(),
      sessionHistory: sharedMemory.getSessionHistory(),
      liveState: sharedMemory.getLiveState(),
      chatHistory: sharedMemory.getChatHistory(),
      themeSettings: sharedMemory.getThemeSettings(),
    });
  });

  // Realtime SSE Stream for Live Tracking Dashboard
  app.get('/api/live-stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendState = () => {
      const stateData = {
        liveState: sharedMemory.getLiveState(),
        activeSession: sharedMemory.getActiveSession(),
        timestamp: new Date().toISOString(),
      };
      res.write(`data: ${JSON.stringify(stateData)}\n\n`);
    };

    sendState();
    const interval = setInterval(sendState, 1500);

    req.on('close', () => {
      clearInterval(interval);
    });
  });

  // Gemini Text-To-Speech API endpoint
  app.post('/api/tts', async (req, res) => {
    const { text, voice } = req.body;
    if (!text) {
      return res.status(400).json({ success: false, message: 'Text is required for TTS' });
    }

    try {
      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL_TTS,
        contents: [{ parts: [{ text: `Say clearly: ${text}` }] }],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: voice || 'Kore' }, // 'Puck', 'Charon', 'Kore', 'Fenrir', 'Zephyr'
            },
          },
        },
      });

      const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('No audio returned from Gemini TTS model');
      }

      res.json({ success: true, audioBase64: base64Audio, mimeType: 'audio/pcm;rate=24000' });
    } catch (error: any) {
      console.error('Gemini TTS error:', error);
      res.status(500).json({ success: false, message: error.message || 'TTS generation failed' });
    }
  });

  // Vite middleware in development vs static server in production
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[InterviewPrep AI] Server running on http://0.0.0.0:${PORT}`);
  });
}

startServer();
