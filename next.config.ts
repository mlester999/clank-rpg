import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Opt-in: lets a second local server (e.g. an isolated-database preview) run beside `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  // PGlite (embedded Postgres, local development only) ships WASM assets that
  // must load from node_modules rather than be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "@napi-rs/canvas"],
  // The hero card image route reads the arena's sprite atlases and the bundled UI font at runtime (fs): make sure a serverless build ships them.
  outputFileTracingIncludes: {
    "/api/hero-cards/[publicId]": ["./public/sprites/**/*", "./node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"],
    "/api/admin/[...path]": ["./public/sprites/**/*", "./node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"],
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
