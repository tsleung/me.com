// Image helpers for the Deep Space companion. Browser only.
//
// Everything here is LOSSLESS PNG on the way out. Thin-stroke alien glyphs
// are exactly the signal lossy codecs eat, so there is deliberately no WebP
// or JPEG path anywhere in this module — the only derivative we make is a
// small thumbnail for the level list, and even that stays PNG.

const MARKER_FILL = "#d81b60";
const MARKER_FONT = "Helvetica, Arial, sans-serif";

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const toHex = (buffer) =>
  Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

// OffscreenCanvas where available, detached <canvas> otherwise.
const makeCanvas = (width, height) => {
  const Off = globalThis.OffscreenCanvas;
  if (typeof Off === "function") return new Off(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
};

// A 2d context can genuinely come back null — too many live canvases, or an
// OffscreenCanvas the engine will not back. Left unchecked the next line is
// "cannot read properties of null", which tells the player nothing.
const canvas2d = (width, height) => {
  const canvas = makeCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error(
      "this browser would not give the page a drawing surface for the screenshot",
    );
  return { canvas, ctx };
};

const canvasToPng = (canvas) => {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type: "image/png" });
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) =>
        blob ? resolve(blob) : reject(new Error("canvas.toBlob produced null")),
      "image/png",
    );
  });
};

const closeBitmap = (bitmap) => {
  if (bitmap && typeof bitmap.close === "function") bitmap.close();
};

// SHA-256 of the raw bytes, lowercase hex. This is the reading-cache key:
// the same pixels always map to the same stored map-call output, which is
// what makes "re-reduce" cost zero vision calls.
export const hashBlob = async (blob) => {
  const bytes = await blob.arrayBuffer();
  return toHex(await crypto.subtle.digest("SHA-256", bytes));
};

// Downscaled PNG copy for the level list. Never sent to the model.
export const makeThumb = async (blob, maxEdge = 320) => {
  // The bitmap is decoded pixels — ~33 MB for a 4K screenshot — so it is
  // closed in a `finally`. Anything that throws between the decode and the
  // draw used to strand it until the next GC, once per failed capture.
  const bitmap = await createImageBitmap(blob);
  let canvas;
  try {
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const surface = canvas2d(width, height);
    canvas = surface.canvas;
    surface.ctx.drawImage(bitmap, 0, 0, width, height);
  } finally {
    closeBitmap(bitmap);
  }
  return canvasToPng(canvas);
};

// Burn numbered markers into a copy of the screenshot. The model cannot see
// normalized coordinates, so the numbers have to be in the pixels; the notes
// travel alongside as markerLegend() text. Radius scales with the image so
// numerals stay legible at full resolution.
export const burnMarkers = async (blob, markers = []) => {
  if (!Array.isArray(markers) || markers.length === 0) return blob;
  const bitmap = await createImageBitmap(blob);
  const { width, height } = bitmap;
  let canvas;
  let ctx;
  try {
    const surface = canvas2d(width, height);
    canvas = surface.canvas;
    ctx = surface.ctx;
    ctx.drawImage(bitmap, 0, 0);
  } finally {
    closeBitmap(bitmap);
  }

  const radius = Math.max(16, Math.round(Math.min(width, height) * 0.03));
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `bold ${Math.round(radius * 1.2)}px ${MARKER_FONT}`;

  markers.forEach((marker, i) => {
    const label = String(marker.label ?? i + 1);
    const cx = clamp(
      (Number(marker.x) || 0) * width,
      radius + 2,
      Math.max(radius + 2, width - radius - 2),
    );
    const cy = clamp(
      (Number(marker.y) || 0) * height,
      radius + 2,
      Math.max(radius + 2, height - radius - 2),
    );
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = MARKER_FILL;
    ctx.fill();
    // Dark halo under a white ring, so the marker reads on any background.
    ctx.lineWidth = Math.max(3, radius * 0.34);
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.stroke();
    ctx.lineWidth = Math.max(2, radius * 0.18);
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(label, cx, cy);
  });

  return canvasToPng(canvas);
};

// Plain-text legend matching the burned-in numbers.
export const markerLegend = (markers = []) => {
  if (!Array.isArray(markers) || markers.length === 0) return "";
  return markers
    .map((marker, i) => {
      const label = String(marker.label ?? i + 1);
      const text = String(marker.text ?? "").trim();
      return `${label}) ${text || "(no note)"}`;
    })
    .join("\n");
};

// Base64 payload only — no `data:` prefix, ready for a Gemini inlineData part.
export const blobToBase64 = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(",");
      resolve(comma === -1 ? "" : url.slice(comma + 1));
    };
    reader.onerror = () =>
      reject(reader.error || new Error("could not read image data"));
    reader.readAsDataURL(blob);
  });

export const imageDims = async (blob) => {
  const bitmap = await createImageBitmap(blob);
  try {
    return { width: bitmap.width, height: bitmap.height };
  } finally {
    closeBitmap(bitmap);
  }
};
