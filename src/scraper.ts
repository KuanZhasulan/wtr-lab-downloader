import { chromium, type Browser, type Page } from "playwright";

export interface Chapter {
  title: string;
  content: string;
  index: number;
}

export interface BookMeta {
  title: string;
  author: string;
  coverUrl?: string;
}

const DELAY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForContent(page: Page) {
  await page.waitForLoadState("load", { timeout: 30_000 });
  await sleep(800);
}

export async function debugPageLinks(novelUrl: string) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();
    await page.goto(novelUrl, { waitUntil: "domcontentloaded" });
    await waitForContent(page);

    return page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
      return {
        totalLinks: allLinks.length,
        // All unique href patterns (deduplicated by path prefix)
        sampleHrefs: [...new Set(allLinks.map(a => a.href))].slice(0, 80),
        // Text of links that look like chapters
        possibleChapterLinks: allLinks
          .filter(a => /chapter|serie|ep\d|ch\d/i.test(a.href) || /chapter\s*\d/i.test(a.textContent ?? ""))
          .map(a => ({ href: a.href, text: a.textContent?.trim().slice(0, 60) }))
          .slice(0, 50),
        pageTitle: document.title,
      };
    });
  } finally {
    await browser.close();
  }
}

export type ProgressCallback = (current: number, total: number, chapterTitle: string) => void;

export async function scrapeBook(
  novelUrl: string,
  fromChapter: number,
  toChapter: number | null,
  headless: boolean,
  onProgress?: ProgressCallback
): Promise<{ meta: BookMeta; chapters: Chapter[] }> {
  const browser = await chromium.launch({ headless });
  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    const page = await context.newPage();

    console.log(`Fetching novel page: ${novelUrl}`);
    await page.goto(novelUrl, { waitUntil: "domcontentloaded" });
    await waitForContent(page);

    const meta = await scrapeBookMeta(page);
    console.log(`Book: "${meta.title}" by ${meta.author}`);

    const chapterLinks = await scrapeChapterList(page, novelUrl);
    console.log(`Found ${chapterLinks.length} chapters total`);

    const end = toChapter ?? chapterLinks.length;
    const selected = chapterLinks.slice(fromChapter - 1, end);
    console.log(`Downloading chapters ${fromChapter}–${end} (${selected.length} chapters)`);

    const chapters: Chapter[] = [];
    for (let i = 0; i < selected.length; i++) {
      const link = selected[i];
      const chapterNum = fromChapter + i;
      process.stdout.write(`  Chapter ${chapterNum}/${end}... `);
      try {
        await page.goto(link, { waitUntil: "domcontentloaded" });
        await waitForContent(page);
        const chapter = await scrapeChapterContent(page, chapterNum);
        chapters.push(chapter);
        console.log(`done (${chapter.content.length} chars)`);
        onProgress?.(i + 1, selected.length, chapter.title);
      } catch (err) {
        console.log(`FAILED: ${err}`);
        onProgress?.(i + 1, selected.length, `Chapter ${chapterNum} (failed)`);
      }
      if (i < selected.length - 1) await sleep(DELAY_MS);
    }

    return { meta, chapters };
  } finally {
    await browser.close();
  }
}

async function scrapeBookMeta(page: Page): Promise<BookMeta> {
  return page.evaluate(() => {
    const title =
      document.querySelector("h1")?.textContent?.trim() ||
      document.querySelector(".novel-title, .book-title, [class*='title']")?.textContent?.trim() ||
      "Unknown Title";

    const authorEl = document.querySelector(
      ".author, [class*='author'], .novel-author"
    );
    const author = authorEl?.textContent?.trim().replace(/^Author:\s*/i, "") || "Unknown";

    const coverEl = document.querySelector(
      ".novel-cover img, .book-cover img, .cover img, img[class*='cover']"
    ) as HTMLImageElement | null;
    const coverUrl = coverEl?.src || undefined;

    return { title, author, coverUrl };
  });
}

async function scrapeChapterList(page: Page, novelUrl: string): Promise<string[]> {
  // Try to collect all chapter links from the novel page.
  // wtr-lab may paginate the chapter list — handle "load more" or pagination.
  const links = await collectChapterLinks(page);

  if (links.length === 0) {
    throw new Error(
      "No chapter links found. The page structure may have changed — run with --no-headless to inspect visually."
    );
  }

  return links;
}

async function collectChapterLinks(page: Page): Promise<string[]> {
  // Click "load more" buttons until all chapters are visible
  let previousCount = 0;
  for (let attempt = 0; attempt < 50; attempt++) {
    const loadMoreBtn = page.locator(
      "button:has-text('Load more'), a:has-text('Load more'), [class*='load-more'], [class*='loadmore']"
    ).first();
    const visible = await loadMoreBtn.isVisible().catch(() => false);
    if (!visible) break;
    await loadMoreBtn.click();
    await sleep(1000);
    const count = await page.locator("a[href*='/chapter-'], a[href*='chapter']").count();
    if (count === previousCount) break;
    previousCount = count;
  }

  const hrefs: string[] = await page.evaluate(() => {
    const anchors = Array.from(document.querySelectorAll("a[href]")) as HTMLAnchorElement[];
    return anchors
      .map((a) => a.href)
      .filter(
        (href) =>
          href.includes("/chapter-") ||
          (href.includes("serie-") && href.includes("chapter"))
      );
  });

  // Deduplicate while preserving order
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const href of hrefs) {
    if (!seen.has(href)) {
      seen.add(href);
      unique.push(href);
    }
  }

  return unique;
}

async function scrapeChapterContent(page: Page, index: number): Promise<Chapter> {
  return page.evaluate((idx) => {
    // Try common content selectors
    const contentSelectors = [
      ".chapter-content",
      ".content",
      "#chapter-content",
      "[class*='chapter-body']",
      "[class*='chapter-text']",
      "article",
      ".reading-content",
      "#reading-content",
    ];

    let contentEl: Element | null = null;
    for (const sel of contentSelectors) {
      contentEl = document.querySelector(sel);
      if (contentEl && contentEl.textContent && contentEl.textContent.trim().length > 200) {
        break;
      }
    }

    // Fallback: largest <div> with substantial text
    if (!contentEl) {
      let maxLen = 0;
      document.querySelectorAll("div, section, main").forEach((el) => {
        const len = el.textContent?.trim().length ?? 0;
        if (len > maxLen) {
          maxLen = len;
          contentEl = el;
        }
      });
    }

    const titleEl = document.querySelector(
      "h1, h2, .chapter-title, [class*='chapter-title']"
    );
    const title = titleEl?.textContent?.trim() || `Chapter ${idx}`;

    // Convert paragraphs to HTML for epub
    const paragraphs = contentEl
      ? Array.from(contentEl.querySelectorAll("p")).map(
          (p) => `<p>${p.innerHTML}</p>`
        )
      : [];

    const content =
      paragraphs.length > 0
        ? paragraphs.join("\n")
        : `<p>${contentEl?.textContent?.trim() ?? ""}</p>`;

    return { title, content, index: idx };
  }, index);
}
