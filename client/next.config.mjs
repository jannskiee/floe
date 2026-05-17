/** @type {import('next').NextConfig} */
const nextConfig = {
    // React Strict Mode intentionally double-mounts components in development
    // to surface side-effect bugs. This would create two Socket.io connections
    // and two WebRTC peer instances — breaking the transfer logic entirely.
    // Strict Mode is therefore kept off. All socket/peer logic uses refs +
    // cleanup functions to avoid the double-mount problem if re-enabled later.
    reactStrictMode: false,
};

export default nextConfig;
