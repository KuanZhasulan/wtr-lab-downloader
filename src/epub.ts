import { EPub } from "epub-gen-memory";
import { writeFile } from "fs/promises";
import type { BookMeta, Chapter } from "./scraper.js";

export async function buildEpub(
  meta: BookMeta,
  chapters: Chapter[],
  outputPath: string
): Promise<void> {
  const content = chapters.map((ch) => ({
    title: ch.title,
    content: ch.content,
  }));

  const options = {
    title: meta.title,
    author: meta.author,
    cover: meta.coverUrl,
    appendChapterTitles: false,
    css: `
      body { font-family: Georgia, serif; line-height: 1.6; margin: 1em 2em; }
      p { margin: 0.8em 0; text-indent: 1.5em; }
      h1, h2 { font-weight: bold; text-align: center; margin: 1em 0; }
    `,
  };

  const epub = await new EPub(options, content).genEpub();
  await writeFile(outputPath, epub);
  console.log(`\nEPUB saved: ${outputPath}`);
}
