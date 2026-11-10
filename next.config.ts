import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  // metrics.ts reads the CSV with fs at runtime. Make sure it ships with the
  // chat route on Vercel, or the serverless function won't find it.
  outputFileTracingIncludes: {
    "/api/chat": ["./data/**/*.csv"],
  },
  partialPrefetching: true,
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
