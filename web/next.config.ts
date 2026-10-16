import type { NextConfig } from "next";

// GitHub Pages hosting: `GITHUB_PAGES=true` builds a plain static site into out/.
// Project sites live under /<repo-name>/, set via PAGES_BASE_PATH (e.g. "/flyer");
// leave it empty for a custom domain or a <username>.github.io repo.
const githubPages = process.env.GITHUB_PAGES === "true";
const basePath = githubPages ? process.env.PAGES_BASE_PATH ?? "" : "";

// The page is fully static (built from web/data/site-data.json), so Cache Components /
// partial prerendering aren't needed, and static export doesn't support them.
const nextConfig: NextConfig = {
  ...(githubPages && { output: "export" as const, basePath, trailingSlash: true }),
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
