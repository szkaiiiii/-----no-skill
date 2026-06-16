export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const key = decodeURIComponent(url.pathname.replace(/^\/storage\//, ""));

  if (env.MS_MEDIA) {
    const object = await env.MS_MEDIA.get(key);
    if (object) {
      const headers = new Headers();
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      if (!headers.has("Content-Type")) headers.set("Content-Type", contentTypeFromName(key));
      return new Response(object.body, { headers });
    }
  }

  if (env.MS_DATA) {
    const stored = await env.MS_DATA.get(`media:${key}`, "json");
    if (stored?.body) {
      return new Response(base64ToArrayBuffer(stored.body), {
        headers: { "Content-Type": stored.contentType || contentTypeFromName(key) }
      });
    }
  }

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404 });
}

function base64ToArrayBuffer(base64) {
  const binary = atob(String(base64).replace(/^data:[^,]+,/, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function contentTypeFromName(name) {
  const lower = String(name).toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".pdf")) return "application/pdf";
  if (lower.endsWith(".docx")) return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (lower.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json; charset=utf-8";
  return "application/octet-stream";
}
