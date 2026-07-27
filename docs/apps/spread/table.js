// Chapter 0: the physical table. Play the game by hand — a shared deck deals
// N cards to N hands, you settle the round, the cards go to the discard, and
// the next deal comes from what's left until the deck can't cover a round and
// you reshuffle. Seeing the deck draw down is the whole point: it's the
// depletion a card-counter will later exploit (slice 2). Pure math (the
// multiplier) comes from sim.js; this file is the table, the cards, and time.

import { makeRng, freshShoe, shuffle } from "./deck.js";
import { roundMultiplier } from "./sim.js";

const payoffOf = (t) => ({ g: 1, l: 1 - 0.5 * t });

const rangeRow = (label, min, max, step, value) => {
  const wrap = document.createElement("label");
  wrap.className = "ctl";
  const name = document.createElement("span");
  name.className = "ctl-name";
  name.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const out = document.createElement("span");
  out.className = "ctl-val";
  wrap.append(name, input, out);
  return { wrap, input, out };
};

const button = (label, cls) => {
  const b = document.createElement("button");
  b.className = "btn" + (cls ? " " + cls : "");
  b.type = "button";
  b.textContent = label;
  return b;
};

const money = (v) => "$" + Math.round(v).toLocaleString("en-US");

export const mountTable = (root) => {
  root.innerHTML = "";
  const rng = makeRng(20260704);

  // --- controls ---
  const controls = document.createElement("div");
  controls.className = "controls";
  const hands = rangeRow("hands per round", 1, 26, 1, 1);
  const edge = rangeRow("payoff", 0, 1, 0.01, 1);
  const stake = rangeRow("stake per round", 0.05, 1, 0.05, 0.5);
  const inject = rangeRow("injected each round", 0, 200, 25, 0);
  controls.append(hands.wrap, edge.wrap, stake.wrap, inject.wrap);

  // --- bet + action bar ---
  const bar = document.createElement("div");
  bar.className = "actionbar";
  const betToggle = button("betting on RED", "bet-toggle red");
  const dealBtn = button("deal", "primary");
  const autoBtn = button("auto-play", "");
  const resetBtn = button("reset", "ghost");
  bar.append(betToggle, dealBtn, autoBtn, resetBtn);

  // --- table felt ---
  const felt = document.createElement("div");
  felt.className = "felt";

  const deckZone = document.createElement("div");
  deckZone.className = "zone deck-zone";
  const deckStack = document.createElement("div");
  deckStack.className = "deck";
  const deckMeta = document.createElement("div");
  deckMeta.className = "zone-meta";
  deckZone.append(deckStack, deckMeta);

  const spotsZone = document.createElement("div");
  spotsZone.className = "zone spots-zone";
  const spots = document.createElement("div");
  spots.className = "spots";
  const spotsMeta = document.createElement("div");
  spotsMeta.className = "zone-meta";
  spotsZone.append(spots, spotsMeta);

  const discardZone = document.createElement("div");
  discardZone.className = "zone discard-zone";
  const discardStack = document.createElement("div");
  discardStack.className = "discard";
  const discardMeta = document.createElement("div");
  discardMeta.className = "zone-meta";
  discardZone.append(discardStack, discardMeta);

  felt.append(deckZone, spotsZone, discardZone);

  // --- bankroll readout ---
  const readout = document.createElement("div");
  readout.className = "readout";

  root.append(controls, bar, felt, readout);

  // --- state ---
  const INIT = 100;
  const st = {
    deck: shuffle(rng, freshShoe()),
    discard: [],
    live: [], // cards on the spots this round
    balance: INIT,
    rounds: 0,
    shuffles: 0,
    handsDealt: 0,
    lastDelta: 0,
    betRed: true,
    auto: null,
  };

  const cfg = () => ({
    nHands: Number(hands.input.value),
    f: Number(stake.input.value),
    injection: Number(inject.input.value),
    payoff: payoffOf(Number(edge.input.value)),
  });

  // --- card + stack rendering ---
  const cardEl = (card, faceUp, extra) => {
    const c = document.createElement("div");
    c.className =
      "card " + (faceUp ? (card.red ? "red" : "black") : "back") + (extra ? " " + extra : "");
    if (faceUp) {
      const r = document.createElement("span");
      r.className = "rank";
      r.textContent = card.rank;
      const s = document.createElement("span");
      s.className = "suit";
      s.textContent = card.suit;
      c.append(r, s);
    }
    return c;
  };

  const renderStack = (host, n, placeholder) => {
    host.textContent = "";
    if (n <= 0) {
      const ph = document.createElement("div");
      ph.className = "card empty";
      ph.textContent = placeholder || "";
      host.append(ph);
      return;
    }
    const shown = Math.min(n, 6);
    for (let i = 0; i < shown; i++) {
      const back = document.createElement("div");
      back.className = "card back stacked";
      back.style.transform = `translate(${i * 2}px, ${-i * 2}px)`;
      host.append(back);
    }
  };

  const redsIn = (cards) => cards.filter((c) => c.red).length;

  const render = () => {
    const { nHands } = cfg();

    renderStack(deckStack, st.deck.length, "shoe");
    const dr = redsIn(st.deck);
    deckMeta.innerHTML = `<b>${st.deck.length}</b> in the deck · ${dr}<span class="pip red">♦</span> ${st.deck.length - dr}<span class="pip black">♠</span>`;

    // spots: show live cards if dealt, else N empty placeholders
    spots.textContent = "";
    if (st.live.length) {
      st.live.forEach((card, i) => {
        const spot = document.createElement("div");
        spot.className = "spot";
        const chip = document.createElement("div");
        chip.className = "chip " + (st.betRed ? "red" : "black");
        chip.textContent = st.betRed ? "R" : "B";
        const c = cardEl(card, true, "dealt");
        c.style.animationDelay = `${Math.min(i, 12) * 55}ms`;
        const won = card.red === st.betRed;
        const res = document.createElement("div");
        res.className = "result " + (won ? "win" : "lose");
        res.textContent = won ? "✓" : "✗";
        spot.append(chip, c, res);
        spots.append(spot);
      });
    } else {
      for (let i = 0; i < nHands; i++) {
        const spot = document.createElement("div");
        spot.className = "spot";
        spot.append(cardEl(null, false, "empty"));
        spots.append(spot);
      }
    }
    const liveReds = redsIn(st.live);
    spotsMeta.innerHTML = st.live.length
      ? `${st.live.length} hands · <b>${st.betRed ? liveReds : st.live.length - liveReds}</b> won`
      : `${nHands} hand${nHands === 1 ? "" : "s"}, ready`;

    renderStack(discardStack, st.discard.length, "empty");
    discardMeta.innerHTML = `<b>${st.discard.length}</b> discarded`;

    const deltaCls = st.lastDelta > 0 ? "up" : st.lastDelta < 0 ? "down" : "";
    const deltaTxt =
      st.rounds === 0
        ? "—"
        : `${st.lastDelta >= 0 ? "+" : "−"}${money(Math.abs(st.lastDelta))}`;
    readout.innerHTML = `
      <div class="stat big"><span class="k">bankroll</span><span class="v">${money(st.balance)}</span><span class="sub ${deltaCls}">last round ${deltaTxt}</span></div>
      <div class="stat"><span class="k">rounds played</span><span class="v">${st.rounds}</span><span class="sub">${st.handsDealt} hands dealt</span></div>
      <div class="stat"><span class="k">reshuffles</span><span class="v">${st.shuffles}</span><span class="sub">deck exhausted ${st.shuffles}×</span></div>`;
  };

  // --- play ---
  const dealRound = () => {
    const { nHands, f, injection, payoff } = cfg();

    // spent cards from the previous round go to the discard
    if (st.live.length) {
      st.discard.push(...st.live);
      st.live = [];
    }
    // reshuffle if the deck can't cover a full round
    if (st.deck.length < nHands) {
      st.deck = shuffle(rng, st.deck.concat(st.discard));
      st.discard = [];
      st.shuffles += 1;
    }
    // deal N cards from the shared deck to N hands
    const dealt = st.deck.splice(st.deck.length - nHands, nHands);
    st.live = dealt;

    const wins = dealt.filter((c) => c.red === st.betRed).length;
    const mult = roundMultiplier(wins, nHands, f, payoff);
    const next = Math.max(0, st.balance * mult) + injection;
    st.lastDelta = next - st.balance;
    st.balance = next;
    st.rounds += 1;
    st.handsDealt += nHands;
    render();
  };

  const stopAuto = () => {
    if (st.auto) {
      clearInterval(st.auto);
      st.auto = null;
    }
    autoBtn.classList.remove("on");
    autoBtn.textContent = "auto-play";
  };

  const toggleAuto = () => {
    if (st.auto) {
      stopAuto();
      return;
    }
    autoBtn.classList.add("on");
    autoBtn.textContent = "stop";
    st.auto = setInterval(() => {
      dealRound();
      // stop if truly busted (no bankroll and no fresh capital coming in)
      if (st.balance <= 0 && Number(inject.input.value) === 0) stopAuto();
    }, 850);
  };

  const reset = () => {
    stopAuto();
    st.deck = shuffle(rng, freshShoe());
    st.discard = [];
    st.live = [];
    st.balance = INIT;
    st.rounds = 0;
    st.shuffles = 0;
    st.handsDealt = 0;
    st.lastDelta = 0;
    render();
  };

  const syncLabels = () => {
    const t = Number(edge.input.value);
    const l = 1 - 0.5 * t;
    hands.out.textContent = hands.input.value;
    edge.out.textContent =
      `win +100% / lose −${Math.round(l * 100)}%` +
      (t >= 0.999 ? " (×2 / ÷2)" : t <= 0.001 ? " (even)" : "");
    stake.out.textContent = Math.round(Number(stake.input.value) * 100) + "%";
    inject.out.textContent = money(Number(inject.input.value));
  };

  // --- wiring ---
  dealBtn.addEventListener("click", dealRound);
  autoBtn.addEventListener("click", toggleAuto);
  resetBtn.addEventListener("click", reset);
  betToggle.addEventListener("click", () => {
    st.betRed = !st.betRed;
    betToggle.textContent = st.betRed ? "betting on RED" : "betting on BLACK";
    betToggle.className = "btn bet-toggle " + (st.betRed ? "red" : "black");
    render();
  });
  hands.input.addEventListener("input", () => {
    st.live = []; // spot count changed — clear the board
    syncLabels();
    render();
  });
  [edge, stake, inject].forEach((c) =>
    c.input.addEventListener("input", () => {
      syncLabels();
      render();
    }),
  );

  syncLabels();
  render();
};
