// Public voice-preview audio endpoint. Streams the bundled preview MP3s.
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// src/server/routes/public -> repo root -> assets/audio/voices
const VOICES_DIR = path.resolve(__dirname, '../../../../assets/audio/voices');

export default function voicesRoutes(): Router {
  const router = Router();

  // GET /api/voices/preview/:voiceName - stream a voice preview clip
  router.get('/api/voices/preview/:voiceName', async (req, res) => {
    try {
      // basename() strips any path components, preventing directory traversal.
      const sanitizedVoiceName = path.basename(req.params.voiceName);
      const voiceFilePath = path.join(VOICES_DIR, `${sanitizedVoiceName}.mp3`);

      if (!fs.existsSync(voiceFilePath)) {
        return res.status(404).json({ error: 'Voice preview not found' });
      }

      res.setHeader('Content-Type', 'audio/mpeg');
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'public, max-age=86400');

      const stream = fs.createReadStream(voiceFilePath);
      stream.pipe(res);
      stream.on('error', (err) => {
        console.error('Error streaming voice preview:', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Failed to stream voice preview' });
        }
      });
    } catch (err) {
      console.error('Failed to serve voice preview:', err);
      res.status(500).json({ error: 'Failed to serve voice preview' });
    }
  });

  return router;
}
