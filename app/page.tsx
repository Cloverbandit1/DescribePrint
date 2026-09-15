import { DescribePrintApp } from "@/components/DescribePrintApp";
import { shouldUseFixture } from "@/lib/fixtures";
import { isLocalAiActive } from "@/lib/llm-config";

export const dynamic = "force-dynamic";

export default function HomePage() {
  const localAi = !shouldUseFixture() && isLocalAiActive();
  return <DescribePrintApp localAi={localAi} />;
}
