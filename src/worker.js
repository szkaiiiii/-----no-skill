import { onRequest as apiRequest } from "../functions/api/[[path]].js";
import { onRequestGet as storageRequest } from "../functions/storage/[[path]].js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const context = { request, env, params: {}, waitUntil: ctx.waitUntil.bind(ctx) };

    if (url.pathname.startsWith("/api/")) return apiRequest(context);
    if (url.pathname.startsWith("/storage/") && request.method === "GET") return storageRequest(context);

    return env.ASSETS.fetch(request);
  }
};
