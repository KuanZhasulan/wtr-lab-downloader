import express from "express";
import { scrapeBook, debugPageLinks } from "./scraper.js";
import { buildEpub } from "./epub.js";
import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";
import { randomUUID } from "crypto";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT ?? 3000;

// Temporary storage for completed EPUBs keyed by jobId
const results = new Map<string, { path: string; filename: string }>();

app.get("/", (_req, res) => {
  res.send(/* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WTR-Lab Downloader</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0f0f0f; color: #e0e0e0;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
      padding: 1rem;
    }
    .card {
      background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 12px;
      padding: 2rem; width: 100%; max-width: 480px;
    }
    h1 { font-size: 1.4rem; margin-bottom: 0.25rem; color: #fff; }
    p.sub { font-size: 0.85rem; color: #666; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8rem; color: #888; margin-bottom: 0.3rem; margin-top: 1rem; }
    input {
      width: 100%; padding: 0.6rem 0.8rem; background: #111; border: 1px solid #333;
      border-radius: 8px; color: #e0e0e0; font-size: 0.95rem; outline: none;
    }
    input:focus { border-color: #555; }
    .row { display: flex; gap: 0.75rem; }
    .row > div { flex: 1; }
    button {
      margin-top: 1.5rem; width: 100%; padding: 0.75rem;
      background: #2563eb; color: #fff; border: none; border-radius: 8px;
      font-size: 1rem; cursor: pointer; transition: background 0.2s;
    }
    button:hover { background: #1d4ed8; }
    button:disabled { background: #333; color: #555; cursor: not-allowed; }

    .progress-wrap { margin-top: 1.25rem; display: none; }
    .progress-label {
      display: flex; justify-content: space-between;
      font-size: 0.8rem; color: #888; margin-bottom: 0.4rem;
    }
    .progress-track {
      width: 100%; height: 6px; background: #2a2a2a; border-radius: 99px; overflow: hidden;
    }
    .progress-bar {
      height: 100%; width: 0%; background: #2563eb; border-radius: 99px;
      transition: width 0.3s ease;
    }
    .chapter-name {
      margin-top: 0.4rem; font-size: 0.75rem; color: #555;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }

    .status { margin-top: 1rem; font-size: 0.85rem; color: #888; text-align: center; min-height: 1.2em; }
    .error { color: #f87171; }
  </style>
</head>
<body>
  <div class="card">
    <h1>WTR-Lab Downloader</h1>
    <p class="sub">Downloads chapters and exports as EPUB</p>
    <form id="form">
      <label>Novel URL</label>
      <input name="url" type="url" required placeholder="https://wtr-lab.com/en/novel/33/martial-peak" />
      <div class="row">
        <div>
          <label>From chapter</label>
          <input name="from" type="number" value="1" min="1" />
        </div>
        <div>
          <label>To chapter <span style="color:#555">(optional)</span></label>
          <input name="to" type="number" min="1" placeholder="all" />
        </div>
      </div>
      <button type="submit" id="btn">Download EPUB</button>
    </form>

    <div class="progress-wrap" id="progressWrap">
      <div class="progress-label">
        <span id="progressText">Starting…</span>
        <span id="progressCount"></span>
      </div>
      <div class="progress-track"><div class="progress-bar" id="progressBar"></div></div>
      <div class="chapter-name" id="chapterName"></div>
    </div>

    <p class="status" id="status"></p>
  </div>
  <script>
    const form = document.getElementById('form');
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');
    const progressWrap = document.getElementById('progressWrap');
    const progressBar = document.getElementById('progressBar');
    const progressText = document.getElementById('progressText');
    const progressCount = document.getElementById('progressCount');
    const chapterName = document.getElementById('chapterName');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Downloading…';
      status.textContent = '';
      status.className = 'status';
      progressWrap.style.display = 'block';
      progressBar.style.width = '0%';
      progressText.textContent = 'Connecting…';
      progressCount.textContent = '';
      chapterName.textContent = '';

      const data = Object.fromEntries(new FormData(form));
      const params = new URLSearchParams({
        url: data.url,
        from: data.from || '1',
        ...(data.to ? { to: data.to } : {}),
      });

      const es = new EventSource('/stream?' + params.toString());

      es.addEventListener('progress', (e) => {
        const { current, total, chapterTitle } = JSON.parse(e.data);
        const pct = Math.round((current / total) * 100);
        progressBar.style.width = pct + '%';
        progressText.textContent = 'Downloading chapters…';
        progressCount.textContent = current + ' / ' + total;
        chapterName.textContent = chapterTitle;
      });

      es.addEventListener('done', (e) => {
        es.close();
        const { jobId, filename } = JSON.parse(e.data);
        progressBar.style.width = '100%';
        progressText.textContent = 'Building EPUB…';
        progressCount.textContent = '';
        chapterName.textContent = '';

        // Trigger download
        const a = document.createElement('a');
        a.href = '/result/' + jobId;
        a.download = filename;
        a.click();

        status.textContent = 'Done! Check your downloads.';
        btn.disabled = false;
        btn.textContent = 'Download EPUB';
        progressText.textContent = 'Complete';
      });

      es.addEventListener('error-event', (e) => {
        es.close();
        const { message } = JSON.parse(e.data);
        status.textContent = message;
        status.className = 'status error';
        progressWrap.style.display = 'none';
        btn.disabled = false;
        btn.textContent = 'Download EPUB';
      });

      es.onerror = () => {
        es.close();
        status.textContent = 'Connection lost. Please try again.';
        status.className = 'status error';
        progressWrap.style.display = 'none';
        btn.disabled = false;
        btn.textContent = 'Download EPUB';
      };
    });
  </script>
</body>
</html>`);
});

app.get("/stream", async (req, res) => {
  const { url, from, to } = req.query as { url: string; from?: string; to?: string };

  if (!url) {
    res.status(400).end();
    return;
  }

  const fromNum = parseInt(from ?? "1", 10);
  const toNum = to ? parseInt(to, 10) : null;

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const send = (event: string, data: object) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let tmpPath: string | null = null;
  try {
    const { meta, chapters } = await scrapeBook(
      url,
      fromNum,
      toNum,
      true,
      (current, total, chapterTitle) => send("progress", { current, total, chapterTitle })
    );

    if (chapters.length === 0) {
      send("error-event", { message: "No chapters were downloaded" });
      res.end();
      return;
    }

    const slug = meta.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const range = toNum ? `_ch${fromNum}-${toNum}` : fromNum > 1 ? `_ch${fromNum}+` : "";
    const filename = `${slug}${range}.epub`;

    const jobId = randomUUID();
    tmpPath = join(tmpdir(), `${jobId}.epub`);
    await buildEpub(meta, chapters, tmpPath);

    results.set(jobId, { path: tmpPath, filename });
    // Clean up after 5 minutes if not downloaded
    setTimeout(() => {
      const entry = results.get(jobId);
      if (entry) {
        results.delete(jobId);
        unlink(entry.path).catch(() => {});
      }
    }, 5 * 60 * 1000);

    send("done", { jobId, filename });
    res.end();
  } catch (err) {
    if (tmpPath) unlink(tmpPath).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error("Stream error:", message);
    send("error-event", { message });
    res.end();
  }
});

app.get("/result/:jobId", (req, res) => {
  const entry = results.get(req.params.jobId);
  if (!entry) {
    res.status(404).send("File not found or already downloaded");
    return;
  }
  results.delete(req.params.jobId);
  res.setHeader("Content-Type", "application/epub+zip");
  res.setHeader("Content-Disposition", `attachment; filename="${entry.filename}"`);
  res.sendFile(entry.path, () => {
    unlink(entry.path).catch(() => {});
  });
});

// Debug endpoint — visit /debug?url=<novel-url> to see all links found on the page
app.get("/debug", async (req, res) => {
  const { url } = req.query as { url?: string };
  if (!url) { res.status(400).send("?url= required"); return; }
  try {
    const result = await debugPageLinks(url);
    res.setHeader("Content-Type", "application/json");
    res.send(JSON.stringify(result, null, 2));
  } catch (err) {
    res.status(500).send(err instanceof Error ? err.message : String(err));
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
