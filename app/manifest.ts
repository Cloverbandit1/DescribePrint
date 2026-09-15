import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.WebManifest {
  return {
    name: "DescribePrint",
    short_name: "DescribePrint",
    description: "Describe anything → printable 3D model (STL / 3MF).",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#2b2b2b",
    theme_color: "#00b347",
    icons: [
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icon-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
