// Local preview servers use the local API. Deployed pages use their own origin.
window.SARRAFAK_API_ORIGIN = ["localhost", "127.0.0.1"].includes(
  window.location.hostname,
)
  ? `${window.location.protocol}//${window.location.hostname}:3000`
  : "";
