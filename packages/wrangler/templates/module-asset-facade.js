// DO NOT IMPORT THIS DIRECTLY
import worker from "__ENTRY_POINT__";
import { getAssetFromKV, NotFoundError } from "__KV_ASSET_HANDLER__";
import manifest from "__STATIC_CONTENT_MANIFEST";
const ASSET_MANIFEST = JSON.parse(manifest);

export default {
  async fetch(request, env, ctx) {
    let options = {
      ASSET_MANIFEST,
      ASSET_NAMESPACE: env.__STATIC_CONTENT,
    };

    try {
      const page = await getAssetFromKV(
        {
          request,
          waitUntil(promise) {
            return ctx.waitUntil(promise);
          },
        },
        options
      );

      // allow headers to be altered
      const response = new Response(page.body, page);

      response.headers.set("X-XSS-Protection", "1; mode=block");
      response.headers.set("X-Content-Type-Options", "nosniff");
      response.headers.set("X-Frame-Options", "DENY");
      response.headers.set("Referrer-Policy", "unsafe-url");
      response.headers.set("Feature-Policy", "none");

      return response;
    } catch (e) {
      if (e instanceof NotFoundError) {
        // if an error is thrown then serve from actual worker
        return worker.fetch(request, env, ctx);
      } else {
        throw e;
      }
    }
  },
};
