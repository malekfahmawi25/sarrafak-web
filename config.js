const localHosts = new Set(["localhost", "127.0.0.1"]);
const githubPagesApiOrigin = "https://sarrafak-web.onrender.com";

// Local previews use the local API, GitHub Pages uses Render, and Render uses its own origin.
window.SARRAFAK_API_ORIGIN = localHosts.has(window.location.hostname)
  ? `${window.location.protocol}//${window.location.hostname}:3000`
  : window.location.hostname.endsWith("github.io")
    ? githubPagesApiOrigin
    : "";
