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

  if (env.ASSETS) return env.ASSETS.fetch(request);
  return new Response("Not found", { status: 404 });
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
