/** @type {import('next').NextConfig} */

// The Flask backend in ../backend serves /api/forecast and /api/chat.
// Proxying through Next keeps the browser on one origin (no CORS, cookies and
// SSE behave normally) and lets the components keep their relative "/api/..." URLs.
const BACKEND_URL = (process.env.BACKEND_URL ?? "http://localhost:8000").replace(/\/$/, "")

const nextConfig = {
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${BACKEND_URL}/api/:path*`,
      },
    ]
  },
}

export default nextConfig
