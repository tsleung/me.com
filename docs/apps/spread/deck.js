// Pure deck model for the spread app. No DOM, no state. A deck is fully
// described by its remaining composition — reds and total — because every
// quantity we care about (a without-replacement draw, a running count) is a
// function of just those two numbers. Unit-tested by __tests__/deck.test.js.

// Seeded PRNG (mulberry32). Deterministic sims → reproducible charts and
// tests. Returns a function producing floats in [0, 1).
export const makeRng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// A standard split: 26 red of 52. Exposed so callers can vary the deck.
export const STANDARD_DECK = { reds: 26, total: 52 };

// Deal `n` cards without replacement from a deck of `total` cards of which
// `reds` are red, and return how many reds came out. Sampled sequentially:
// each draw is red with probability redsLeft / cardsLeft, then the deck
// shrinks. Exact — this IS the hypergeometric distribution, no array needed,
// so it stays cheap enough to call in the hot Monte-Carlo loop.
export const drawReds = (rng, reds, total, n) => {
  let redsLeft = reds;
  let cardsLeft = total;
  let out = 0;
  const draws = Math.min(n, total);
  for (let i = 0; i < draws; i++) {
    if (rng() * cardsLeft < redsLeft) {
      redsLeft -= 1;
      out += 1;
    }
    cardsLeft -= 1;
  }
  return out;
};

// A physical shuffle, for the "deal these actual cards" animation — not the
// hot path. Fisher–Yates over an array of booleans (true = red).
export const shuffledDeck = (rng, reds = 26, total = 52) => {
  const cards = Array.from({ length: total }, (_, i) => i < reds);
  for (let i = total - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
};

// --- suited cards, for the physical table -----------------------------------
// A real 52-card deck: color is intrinsic to the suit, and rank is carried so
// the same table can later bet on other card features (suit, face, rank).
export const RANKS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export const SUITS = [
  { glyph: "♠", red: false },
  { glyph: "♥", red: true },
  { glyph: "♦", red: true },
  { glyph: "♣", red: false },
];

// An ordered deck of 52 card objects { rank, suit, red, id }. Shuffle it with
// `shuffle` before dealing.
export const freshShoe = () => {
  const cards = [];
  let id = 0;
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      cards.push({ rank, suit: suit.glyph, red: suit.red, id: id++ });
    }
  }
  return cards;
};

// In-place Fisher–Yates on any array; returns the same array for chaining.
export const shuffle = (rng, arr) => {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
};
