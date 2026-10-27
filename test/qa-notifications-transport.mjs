// This fixture only permits loopback traffic; notification sends use a real local HTTPS receiver.
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("QA forbids external network requests");
  return nativeFetch(input, options);
};
