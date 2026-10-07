import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Opt-in: lets a second local server (e.g. an isolated-database preview) run beside `pnpm dev`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  poweredByHeader: false,
  reactStrictMode: true,
  // PGlite (embedded Postgres, local development only) ships WASM assets that
  // must load from node_modules rather than be bundled.
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "@napi-rs/canvas"],
  // The hero card image route reads the arena's sprite atlases, the four rarity arena backgrounds and the bundled UI font at runtime (fs): make sure a
  // serverless build ships them.
  outputFileTracingIncludes: {
    "/api/hero-cards/[publicId]": ["./public/sprites/**/*", "./public/hero-card-backgrounds/**/*", "./node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"],
    "/api/admin/[...path]": ["./public/sprites/**/*", "./public/hero-card-backgrounds/**/*", "./node_modules/next/dist/compiled/@vercel/og/Geist-Regular.ttf"],
  },
  async headers() {
    return [
      {
        // The four rarity arena images are static and large (≈ 0.4 MB each): the browser keeps them for a day instead of re-asking on every card.
        source: "/hero-card-backgrounds/:file*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400, stale-while-revalidate=604800" }],
      },
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
