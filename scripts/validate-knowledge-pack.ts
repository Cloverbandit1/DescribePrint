/**
 * Validate lib/knowledge/pack.json against the in-repo schema.
 *
 *   npm run knowledge:validate
 *
 * Exit 0 when the pack is usable. Exit 1 on JSON or schema errors.
 * This is not a live web crawl.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { formatKnowledgePackIssues, validateKnowledgePack } from "../lib/knowledge/schema";

const packPath = path.resolve(process.cwd(), "lib/knowledge/pack.json");

function main(): number {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(packPath, "utf8"));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`knowledge pack: cannot read ${packPath}: ${message}`);
    return 1;
  }
  const result = validateKnowledgePack(raw);
  if (!result.ok) {
    console.error(`knowledge pack: schema failed\n${formatKnowledgePackIssues(result.issues)}`);
    return 1;
  }
  const { pack } = result;
  console.log(
    `knowledge pack v${pack.meta.version} ok — ${pack.characters.length} characters, ${pack.tech.length} tech (curated stub, live_web_crawl=${pack.meta.live_web_crawl})`,
  );
  return 0;
}

process.exit(main());
