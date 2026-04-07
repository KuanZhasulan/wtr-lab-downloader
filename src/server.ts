import express from "express";
import { scrapeBook } from "./scraper.js";
import { buildEpub } from "./epub.js";
import { tmpdir } from "os";
import { join } from "path";
import { unlink } from "fs/promises";

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const PORT = process.env.PORT ?? 3000;

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
    <p class="status" id="status"></p>
  </div>
  <script>
    const form = document.getElementById('form');
    const btn = document.getElementById('btn');
    const status = document.getElementById('status');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      btn.textContent = 'Downloading…';
      status.textContent = 'Scraping chapters — this may take a few minutes…';
      status.className = 'status';

      const body = Object.fromEntries(new FormData(form));
      try {
        const res = await fetch('/download', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const { error } = await res.json();
          throw new Error(error);
        }
        const blob = await res.blob();
        const filename = res.headers.get('X-Filename') ?? 'book.epub';
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = filename;
        a.click();
        status.textContent = 'Done! Check your downloads.';
      } catch (err) {
        status.textContent = err.message;
        status.className = 'status error';
      } finally {
        btn.disabled = false;
        btn.textContent = 'Download EPUB';
      }
    });
  </script>
</body>
</html>`);
});

app.post("/download", async (req, res) => {
  const { url, from, to } = req.body as { url: string; from?: string; to?: string };

  if (!url) {
    res.status(400).json({ error: "url is required" });
    return;
  }

  const fromNum = parseInt(from ?? "1", 10);
  const toNum = to && to !== "" ? parseInt(to, 10) : null;

  if (isNaN(fromNum) || fromNum < 1) {
    res.status(400).json({ error: "from must be a positive integer" });
    return;
  }
  if (toNum !== null && toNum < fromNum) {
    res.status(400).json({ error: "to must be >= from" });
    return;
  }

  let tmpPath: string | null = null;
  try {
    const { meta, chapters } = await scrapeBook(url, fromNum, toNum, true);

    if (chapters.length === 0) {
      res.status(422).json({ error: "No chapters were downloaded" });
      return;
    }

    const slug = meta.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60);
    const range = toNum ? `_ch${fromNum}-${toNum}` : fromNum > 1 ? `_ch${fromNum}+` : "";
    const filename = `${slug}${range}.epub`;

    tmpPath = join(tmpdir(), `${Date.now()}-${filename}`);
    await buildEpub(meta, chapters, tmpPath);

    res.setHeader("Content-Type", "application/epub+zip");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("X-Filename", filename);
    res.sendFile(tmpPath, () => {
      if (tmpPath) unlink(tmpPath).catch(() => {});
    });
  } catch (err) {
    if (tmpPath) unlink(tmpPath).catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    console.error("Download error:", message);
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
