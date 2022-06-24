globalThis.__inner_sw_fetch_listeners__ = [];
export function swAssetHandlerAddEventListener(event, listener) {
  if (event === "fetch") {
    globalThis.__inner_sw_fetch_listeners__.push(listener);
  } else {
    globalThis.addEventListener(event, listener);
  }
}
