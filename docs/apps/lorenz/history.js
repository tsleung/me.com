// history.js — a fixed-capacity ring buffer.
//
// The primitive underneath two different histories, which is why it lives on
// its own rather than inside either of them:
//
//   · trail.js   — the drawn vertices, for redrawing the trail each frame
//   · app.js     — the ‖Δ‖ series the divergence chart and live λ fit read
//
// Both are fixed-capacity and both are written far more often than they are
// read, which is the case a ring buffer exists for. The `sampler` below is the
// other half: gating on SIMULATED time keeps a series at constant density no
// matter how fast playback is running.

/** A ring buffer over `capacity` items. Oldest-first on read. */
export function ringBuffer(capacity) {
  const buf = new Array(capacity);
  let head = 0;
  let count = 0;

  return {
    push(item) {
      buf[head] = item;
      head = (head + 1) % capacity;
      if (count < capacity) count++;
      return item;
    },
    get size() {
      return count;
    },
    get capacity() {
      return capacity;
    },
    clear() {
      head = 0;
      count = 0;
    },
    last() {
      return count === 0 ? undefined : buf[(head - 1 + capacity) % capacity];
    },
    first() {
      return count === 0 ? undefined : buf[(head - count + capacity) % capacity];
    },
    toArray() {
      const out = new Array(count);
      const start = (head - count + capacity) % capacity;
      for (let i = 0; i < count; i++) out[i] = buf[(start + i) % capacity];
      return out;
    },
  };
}

/**
 * A sim-time-gated sampler: calls through only once `interval` of SIMULATED
 * time has passed. Keeps the recorded series at a constant density regardless
 * of playback speed, which is the property the λ fit depends on.
 */
export function sampler(interval) {
  let nextAt = -Infinity;
  return {
    due(t) {
      if (t < nextAt) return false;
      nextAt = t + interval;
      return true;
    },
    reset(t = -Infinity) {
      nextAt = t;
    },
  };
}
