// Bug report -> flightdeck. Public (no auth/session); mounted before the
// session + IP-geo middleware so reports work from anywhere.
import { Router } from 'express';
import busboy from 'busboy';

const MAX_FILES = 4;
const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8MB, mirrors flightdeck's cap

// Magic-byte sniff for the image types flightdeck accepts. Flightdeck sniffs
// again server-side; this just rejects junk before we buffer/forward it.
function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  if (buf.length >= 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'))) return 'image/gif';
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flightdeckBase(): string {
  return (process.env.FLIGHTDECK_URL || 'http://flightdeck:8080').replace(/\/$/, '');
}

export default function bugReportRoutes(): Router {
  const router = Router();

  router.post('/api/bug-report', async (req, res) => {
    const key = process.env.FLIGHTDECK_INGEST_KEY;
    if (!key) return res.status(503).json({ error: 'Bug reporting is not configured.' });

    const { message, severity, url, meta } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'A description is required.' });
    }

    try {
      const r = await fetch(flightdeckBase() + '/api/ingest/bug', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({
          site: 'ai-therapist',
          url: url || '',
          message: message.trim().slice(0, 5000),
          severity: ['low', 'med', 'high', 'urgent'].includes(severity) ? severity : 'med',
          meta: meta || {},
        }),
      });
      if (!r.ok) throw new Error('ingest ' + r.status);
      // Flightdeck returns the created item, including its uuid "id"; surface
      // it so the client can attach screenshots to the report it just filed.
      const created = (await r.json().catch(() => null)) as { id?: string } | null;
      res.json({ ok: true, id: created?.id || null });
    } catch (err) {
      console.error('bug-report forward failed:', err);
      res.status(502).json({ error: 'Could not reach the bug tracker.' });
    }
  });

  // Screenshot attachments for a just-created report. Parses the multipart
  // upload here (enforcing 4 files x 8MB, images only) and re-posts it to
  // flightdeck with the server-held ingest key — the key never leaves the
  // server. No DB involved.
  router.post('/api/bug-report/:id/screenshots', (req, res) => {
    const key = process.env.FLIGHTDECK_INGEST_KEY;
    if (!key) return res.status(503).json({ error: 'Bug reporting is not configured.' });

    const itemId = req.params.id;
    if (!UUID_RE.test(itemId)) return res.status(400).json({ error: 'Invalid report id.' });
    if (!/^multipart\/form-data/i.test(req.headers['content-type'] || '')) {
      return res.status(400).json({ error: 'Expected multipart/form-data.' });
    }

    const files: { name: string; type: string; data: Buffer }[] = [];
    let failed = false;
    const fail = (status: number, error: string) => {
      if (failed) return;
      failed = true;
      req.unpipe(bb);
      req.resume(); // drain the rest of the upload so the socket stays usable
      res.status(status).json({ error });
    };

    let bb: ReturnType<typeof busboy>;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 0, parts: MAX_FILES + 1 },
      });
    } catch (err) {
      console.error('screenshot upload: bad multipart headers:', err);
      return res.status(400).json({ error: 'Malformed upload.' });
    }

    bb.on('file', (field, stream, info) => {
      if (field !== 'files') {
        stream.resume();
        return fail(400, 'Unexpected field "' + field + '"; use "files".');
      }
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => { if (!failed) chunks.push(c); });
      stream.on('limit', () => fail(413, 'Each screenshot must be 8MB or less.'));
      stream.on('close', () => {
        if (failed) return;
        const data = Buffer.concat(chunks);
        if (!sniffImage(data)) return fail(415, 'Only PNG, JPEG, WebP, or GIF images are allowed.');
        files.push({ name: (info.filename || 'screenshot').slice(0, 200), type: info.mimeType, data });
      });
    });
    bb.on('filesLimit', () => fail(400, `At most ${MAX_FILES} screenshots per report.`));
    bb.on('partsLimit', () => fail(400, `At most ${MAX_FILES} screenshots per report.`));
    bb.on('fieldsLimit', () => fail(400, 'Only file parts are allowed.'));
    bb.on('error', (err: unknown) => {
      console.error('screenshot upload parse failed:', err);
      fail(400, 'Malformed upload.');
    });

    bb.on('close', async () => {
      if (failed) return;
      if (files.length === 0) return fail(400, 'No screenshots in upload.');
      try {
        const form = new FormData();
        for (const f of files) {
          form.append('files', new Blob([new Uint8Array(f.data)], { type: f.type }), f.name);
        }
        const r = await fetch(`${flightdeckBase()}/api/ingest/attachments/${itemId}`, {
          method: 'POST',
          headers: { 'X-API-Key': key },
          body: form,
        });
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          console.error('screenshot forward rejected:', r.status, body);
          return res.status(r.status === 404 || r.status === 410 ? 410 : 502)
            .json({ error: 'Could not attach screenshots.' });
        }
        res.status(201).json({ ok: true, attachments: body });
      } catch (err) {
        console.error('screenshot forward failed:', err);
        res.status(502).json({ error: 'Could not reach the bug tracker.' });
      }
    });

    req.pipe(bb);
  });

  return router;
}
