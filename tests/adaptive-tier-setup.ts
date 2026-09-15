import { afterEach } from "vitest";
import { resetAdaptiveTierForTests } from "@/lib/llm-tier";

afterEach(() => {
  resetAdaptiveTierForTests();
});
