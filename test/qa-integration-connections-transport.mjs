// Explicitly imported by the connection QA tests only: the server may reach this machine, never the network.
const nativeFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) return nativeFetch(input, options);
  throw new Error("QA forbids external network requests");
};
