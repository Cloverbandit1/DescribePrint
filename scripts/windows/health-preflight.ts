/**
 * Cheap launch preflight for Start-DescribePrint.
 * Prints PASS/WARN/FAIL for Ollama+MODEL and OpenSCAD, then exits 0 (pass) or 2 (soft).
 * Exit 1 is only for unexpected runner errors — Start still continues.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatHealthPreflight,
  loadDescribePrintEnv,
  PREFLIGHT_EXIT,
  runHealthPreflight,
} from "../../lib/health-preflight";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
process.chdir(root);
loadDescribePrintEnv(root);

try {
  const result = await runHealthPreflight();
  process.stdout.write(`${formatHealthPreflight(result)}\n`);
  process.exit(result.exitCode);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`DescribePrint preflight could not run: ${message}\n`);
  process.exit(PREFLIGHT_EXIT.hard);
}
