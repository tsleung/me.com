// Host half of the local code-execution sandbox.
//
// Model-generated JavaScript runs inside an <iframe sandbox="allow-scripts">
// pointed at ./sandbox.html. The sandbox attribute WITHOUT allow-same-origin
// puts the guest document on an *opaque origin*, which is enforced by the
// attribute itself rather than by a CSP response header — the reason this
// works on GitHub Pages, which cannot set response headers.
//
// WHAT THIS PROTECTS AGAINST
//   - Reading the user's Gemini API key, op log, readings, or screenshots:
//     the guest's `indexedDB` / `localStorage` / `sessionStorage` / cookies
//     belong to the opaque origin, not to ours. There is nothing there.
//   - Touching the app's DOM: cross-origin frames cannot reach `parent`
//     beyond `postMessage`, so the guest cannot read or rewrite our UI.
//   - Hanging the app: every run has a hard timeout that tears the frame
//     down, and the frame is always removed afterwards.
//   - Navigating us away: no allow-top-navigation, no allow-popups,
//     no allow-forms, no allow-modals.
//
// WHAT THIS DOES NOT PROTECT AGAINST
//   - Network egress. An opaque origin still has `fetch`, and CORS does not
//     stop a no-cors POST or an image beacon, so generated code could in
//     principle exfiltrate whatever it was handed. The mitigation is that we
//     hand it nothing: `input` is caller-chosen data, no credentials, no
//     helpers, and sandbox.html additionally shadows `fetch`,
//     `XMLHttpRequest`, `WebSocket`, `EventSource` and friends out of scope
//     for the compiled function. That shadowing is convenience hardening, not
//     a boundary — do not pass secrets in `input`.
//   - CPU burn inside the timeout window, or a tight synchronous loop that
//     ignores the timeout until the frame is detached.
//
// DO NOT add "allow-same-origin" to the sandbox attribute. Combined with
// allow-scripts it lets the guest remove its own sandboxing, and every
// property above evaporates.

const CHANNEL = "ds-sandbox";
const GUEST_URL = new URL("./sandbox.html", import.meta.url).href;

let runCounter = 0;

const nextRunId = () => `${CHANNEL}-${++runCounter}`;

const createFrame = () => {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.setAttribute("aria-hidden", "true");
  frame.setAttribute("title", "sandboxed code runner");
  frame.style.cssText =
    "position:absolute;width:0;height:0;border:0;visibility:hidden;left:-9999px;";
  frame.src = GUEST_URL;
  return frame;
};

const failure = (error, logs = []) => ({
  ok: false,
  result: null,
  logs,
  error,
});

/**
 * Run a generated function body in the sandboxed iframe.
 *
 * The contract for `code` is a FUNCTION BODY that receives an `input` object
 * and returns a value (`await` is allowed). Returned values must survive a
 * structured clone; sandbox.html degrades non-cloneable results to JSON and
 * then to a string rather than failing the run.
 *
 * Never rejects — failures come back as `{ ok:false, error }` so the UI can
 * render them the same way it renders a successful run.
 *
 * @param {string} code function body to execute
 * @param {unknown} input value bound to `input` inside the body
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ok: boolean, result: unknown, logs: string[], error: string|null}>}
 */
export async function runInSandbox(code, input, { timeoutMs = 3000 } = {}) {
  if (typeof code !== "string" || code.trim() === "") {
    return failure("no code supplied");
  }

  const id = nextRunId();
  const frame = createFrame();

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      window.removeEventListener("message", onMessage);
      if (frame.parentNode) frame.parentNode.removeChild(frame);
    };

    const settle = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };

    function onMessage(event) {
      // Key the listener to this frame. The guest is on an opaque origin, so
      // event.origin is the string "null" for every sandboxed frame on the
      // page — source identity is the only trustworthy discriminator.
      if (event.source !== frame.contentWindow) return;
      const data = event.data;
      if (!data || data.channel !== CHANNEL) return;

      if (data.type === "ready") {
        frame.contentWindow.postMessage(
          { channel: CHANNEL, type: "run", id, code, input },
          "*",
        );
        return;
      }

      if (data.type === "result" && data.id === id) {
        settle({
          ok: Boolean(data.ok),
          result: data.ok ? data.result : null,
          logs: Array.isArray(data.logs) ? data.logs : [],
          error: data.ok ? null : data.error || "unknown sandbox error",
        });
      }
    }

    window.addEventListener("message", onMessage);

    // Hard deadline. Covers a runaway loop, a guest that never posts a
    // result, and sandbox.html failing to load at all.
    timer = setTimeout(() => {
      settle(failure(`sandboxed run timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    frame.addEventListener("error", () => {
      settle(failure("could not load the sandbox document (sandbox.html)"));
    });

    document.body.appendChild(frame);
  });
}
