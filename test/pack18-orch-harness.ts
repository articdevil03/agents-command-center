// A call to a leader bridge endpoint (a JSON-RPC POST with an optional bearer token), shared by the fixed crew bridge tests.
export const bridgeCall = async (url: string, token: string | null, method: string, params: object = {}) => {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const text = await r.text(); let body: any = null; try { body = JSON.parse(text); } catch { /* not json */ }
  return { status: r.status, body };
};
