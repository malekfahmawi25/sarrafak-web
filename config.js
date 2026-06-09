const localHosts = new Set(["localhost", "127.0.0.1"]);
const githubPagesApiOrigin = "https://sarrafak-web.onrender.com";
const isLocalHost = localHosts.has(window.location.hostname);
const isLocalNodeServer = isLocalHost && window.location.port === "3000";

// Live Server and GitHub Pages use Render. The local Node server and Render use their own origin.
window.SARRAFAK_API_ORIGIN = isLocalNodeServer
  ? ""
  : isLocalHost || window.location.hostname.endsWith("github.io")
    ? githubPagesApiOrigin
    : "";
