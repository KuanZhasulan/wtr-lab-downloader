import { Command } from "commander";
import { resolve } from "path";
import { scrapeBook } from "./scraper.js";
import { buildEpub } from "./epub.js";

const program = new Command();

program
  .name("wtr-lab-dl")
  .description("Download chapters from wtr-lab.com and export as EPUB")
  .argument("<url>", "Novel page URL, e.g. https://wtr-lab.com/en/novel/33/martial-peak")
  .option("-f, --from <number>", "Start chapter (inclusive)", "1")
  .option("-t, --to <number>", "End chapter (inclusive, default: all)")
  .option("-o, --output <path>", "Output .epub file path")
  .option("--no-headless", "Show browser window (useful for debugging)")
  .action(async (url: string, opts) => {
    const from = parseInt(opts.from, 10);
    const to = opts.to ? parseInt(opts.to, 10) : null;
    const headless = opts.headless !== false;

    if (isNaN(from) || from < 1) {
      console.error("--from must be a positive integer");
      process.exit(1);
    }
    if (to !== null && (isNaN(to) || to < from)) {
      console.error("--to must be >= --from");
      process.exit(1);
    }

    try {
      const { meta, chapters } = await scrapeBook(url, from, to, headless);

      if (chapters.length === 0) {
        console.error("No chapters were downloaded.");
        process.exit(1);
      }

      const slug = meta.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 60);

      const chapterRange = to ? `_ch${from}-${to}` : from > 1 ? `_ch${from}+` : "";
      const defaultOutput = `${slug}${chapterRange}.epub`;
      const outputPath = resolve(opts.output ?? defaultOutput);

      await buildEpub(meta, chapters, outputPath);
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

program.parse();
