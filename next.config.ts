import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // V0 compiles OpenSCAD in a Node subprocess. Run with `next dev` / `next start`
  // (standalone Node), not a serverless-only host.
  serverExternalPackages: ["mqtt"],
};

export default nextConfig;
