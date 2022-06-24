// DO NOT IMPORT THIS DIRECTLY
import "__ENTRY_POINT__"; // inside this worker, our user will call addEventListener/swAssetHandlerAddEventListener and register theur fetch listeneers
import { getAssetFromKV, NotFoundError } from "__KV_ASSET_HANDLER__";

globalThis.addEventListener("fetch", handleFetchEvent);

function handleFetchEvent(event) {
  event.respondWith(
    (async () => {
      try {
        const page = await getAssetFromKV(event);

        // allow headers to be altered
        const response = new Response(page.body, page);

        response.headers.set("X-XSS-Protection", "1; mode=block");
        response.headers.set("X-Content-Type-Options", "nosniff");
        response.headers.set("X-Frame-Options", "DENY");
        response.headers.set("Referrer-Policy", "unsafe-url");
        response.headers.set("Feature-Policy", "none");
        return response;
      } catch (err) {
        if (err instanceof NotFoundError) {
          return new Promise((resolve, reject) => {
            const evt = {
              ...event,
              respondWith(response) {
                resolve(response);
              },
            };
            for (const listener of globalThis.__inner_sw_fetch_listeners__) {
              listener(evt);
            }
          });
        } else throw err;
      }
    })()
  );
}
