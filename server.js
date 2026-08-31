import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const http = createServer(app);
const io = new Server(http, { cors: { origin: "*" } });
const rooms = new Map();
const suits = ["♠", "♥", "♦", "♣"];
const ranks = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];
const uid = () => crypto.randomUUID();
const roomCode = () => Math.random().toString(36).slice(2, 7).toUpperCase();
const newDeck = () => {
  const d = suits.flatMap((s) => ranks.map((r) => ({ r, s })));
  for (let i = d.length - 1; i; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
};
const score = (hand) => {
  let n = 0,
    a = 0;
  for (const c of hand.cards) {
    if (c.r === "A") {
      n += 11;
      a++;
    } else n += ["J", "Q", "K"].includes(c.r) ? 10 : +c.r;
  }
  while (n > 21 && a) {
    n -= 10;
    a--;
  }
  return n;
};
const cardValue = (c) =>
  c.r === "A" ? 11 : ["J", "Q", "K"].includes(c.r) ? 10 : +c.r;
const makeHand = (bet) => ({
  id: uid(),
  bet,
  cards: [],
  done: false,
  doubled: false,
  split: false,
  result: null,
});
const player = (name, dealer = false) => ({
  id: uid(),
  key: uid(),
  sid: null,
  name,
  role: dealer ? "dealer" : "player",
  balance: 0,
  bet: 10,
  spots: 1,
  hands: [],
  offline: false,
});
const view = (r) => ({
  ...r,
  deck: undefined,
  players: r.players.map((p) => ({ ...p, key: undefined, sid: undefined })),
});
const emit = (r) => io.to(r.code).emit("room", view(r));
const current = (r) => r.queue[r.turn] || null;
const playerOf = (r, id) => r.players.find((p) => p.id === id);
const handOf = (r, q) =>
  playerOf(r, q?.playerId)?.hands.find((h) => h.id === q?.handId);

function finish(r) {
  const dealer = playerOf(r, r.dealerId),
    dh = dealer.hands[0],
    ds = score(dh),
    dealerBJ = ds === 21 && dh.cards.length === 2;
  for (const p of r.players.filter((x) => x.id !== dealer.id))
    for (const h of p.hands) {
      const ps = score(h),
        natural = ps === 21 && h.cards.length === 2 && !h.split;
      let delta = 0,
        label = "แพ้";
      if (ps > 21) {
        delta = -h.bet;
        label = "ไพ่เกิน";
      } else if (natural && !dealerBJ) {
        delta = h.bet * 1.5;
        label = "Blackjack";
      } else if (dealerBJ && !natural) {
        delta = -h.bet;
        label = "เจ้ามือ Blackjack";
      } else if (ds > 21 || ps > ds) {
        delta = h.bet;
        label = "ชนะ";
      } else if (ps === ds) {
        label = "เสมอ";
      } else delta = -h.bet;
      h.result = { label, delta };
      p.balance += delta;
      dealer.balance -= delta;
    }
  r.phase = "result";
  r.message = "จบขาแล้ว";
  r.history.unshift({
    round: r.round,
    at: Date.now(),
    dealer: dealer.name,
    results: r.players
      .filter((p) => p.id !== dealer.id)
      .map((p) => ({
        name: p.name,
        delta: p.hands.reduce((n, h) => n + (h.result?.delta || 0), 0),
      })),
  });
  emit(r);
}

function advance(r) {
  r.turn++;
  const q = current(r);
  if (q) {
    r.message = `ตาของ ${playerOf(r, q.playerId).name}`;
    emit(r);
    return;
  }
  const dealer = playerOf(r, r.dealerId),
    h = dealer.hands[0];
  r.message = `ตาเจ้ามือ ${dealer.name}`;
  if (score(h) >= 17) finish(r);
  else emit(r);
}

function validName(raw) {
  const n = String(raw || "").trim();
  return n.length >= 1 && n.length <= 20 ? n : null;
}

io.on("connection", (socket) => {
  socket.on("create", ({ name }, cb) => {
    name = validName(name);
    if (!name) return cb({ ok: false, error: "กรุณากรอกชื่อ 1–20 ตัวอักษร" });
    let code;
    do code = roomCode();
    while (rooms.has(code));
    const p = player(name, true);
    p.sid = socket.id;
    const r = {
      code,
      hostId: p.id,
      dealerId: p.id,
      dealerRequest: null,
      phase: "lobby",
      round: 0,
      players: [p],
      deck: [],
      queue: [],
      turn: 0,
      message: `${p.name} เป็นเจ้ามือคนแรก`,
      history: [],
    };
    rooms.set(code, r);
    socket.join(code);
    socket.data = { code, id: p.id };
    emit(r);
    cb({ ok: true, id: p.id, key: p.key, code });
  });
  socket.on("join", ({ code, name }, cb) => {
    name = validName(name);
    if (!name) return cb({ ok: false, error: "กรุณากรอกชื่อ 1–20 ตัวอักษร" });
    const r = rooms.get(String(code || "").toUpperCase());
    if (!r) return cb({ ok: false, error: "ไม่พบห้อง" });
    if (r.players.length >= 8) return cb({ ok: false, error: "ห้องเต็ม" });
    const p = player(name);
    p.sid = socket.id;
    r.players.push(p);
    socket.join(r.code);
    socket.data = { code: r.code, id: p.id };
    emit(r);
    cb({ ok: true, id: p.id, key: p.key, code: r.code });
  });
  socket.on("resume", ({ code, id, key }, cb) => {
    const r = rooms.get(String(code || "").toUpperCase()),
      p = r?.players.find((x) => x.id === id && x.key === key);
    if (!p) return cb({ ok: false });
    p.sid = socket.id;
    p.offline = false;
    socket.join(r.code);
    socket.data = { code: r.code, id: p.id };
    emit(r);
    cb({ ok: true, id: p.id, code: r.code });
  });
  socket.on("emoji", (emoji) => {
    const r = rooms.get(socket.data?.code),
      p = r && playerOf(r, socket.data.id);
    if (!p || !["😂", "😮", "🔥", "👏", "😭", "😎"].includes(emoji)) return;
    io.to(r.code).emit("emoji", {
      id: uid(),
      playerId: p.id,
      name: p.name,
      emoji,
    });
  });
  socket.on("leave", (payload, cb = () => {}) => {
    const r = rooms.get(socket.data?.code);
    const leaving = r && playerOf(r, socket.data.id);
    if (!r || !leaving) return cb({ ok: true });
    if (r.phase === "playing")
      return cb({ ok: false, error: "ออกจากห้องได้หลังจบขานี้" });
    r.players = r.players.filter((p) => p.id !== leaving.id);
    socket.leave(r.code);
    socket.data = {};
    if (!r.players.length) {
      rooms.delete(r.code);
      return cb({ ok: true });
    }
    if (r.hostId === leaving.id) r.hostId = r.players[0].id;
    if (r.dealerId === leaving.id) {
      r.dealerId = r.players[0].id;
      r.players.forEach(
        (p) => (p.role = p.id === r.dealerId ? "dealer" : "player"),
      );
      r.message = `${r.players[0].name} เป็นเจ้ามือคนใหม่`;
    }
    if (r.dealerRequest === leaving.id) r.dealerRequest = null;
    emit(r);
    cb({ ok: true });
  });
  socket.on("action", (a, cb = () => {}) => {
    const r = rooms.get(socket.data?.code),
      p = r && playerOf(r, socket.data.id);
    if (!r || !p) return cb({ ok: false, error: "ไม่พบห้อง" });
    const fail = (error) => cb({ ok: false, error });
    if (a.type === "requestDealer") {
      if (p.id === r.dealerId) return fail("คุณเป็นเจ้ามืออยู่แล้ว");
      if (r.phase === "playing")
        return fail("ขอเปลี่ยนเจ้ามือระหว่างเล่นไม่ได้");
      r.dealerRequest = p.id;
      r.message = `${p.name} ขอเป็นเจ้ามือ`;
      emit(r);
    } else if (a.type === "approveDealer") {
      if (p.id !== r.dealerId) return fail("เฉพาะเจ้ามือปัจจุบันอนุมัติได้");
      const next = playerOf(r, r.dealerRequest);
      if (!next) return fail("ไม่มีคำขอ");
      p.role = "player";
      next.role = "dealer";
      r.dealerId = next.id;
      r.dealerRequest = null;
      r.message = `${next.name} เป็นเจ้ามือแล้ว`;
      emit(r);
    } else if (a.type === "denyDealer") {
      if (p.id !== r.dealerId) return fail("เฉพาะเจ้ามือปัจจุบันปฏิเสธได้");
      r.dealerRequest = null;
      r.message = "เจ้ามือปฏิเสธคำขอ";
      emit(r);
    } else if (a.type === "bet") {
      const n = Math.floor(+a.value);
      if (r.phase === "playing" || p.id === r.dealerId)
        return fail("วางเดิมพันไม่ได้");
      if (n < 10 || n > 500) return fail("เดิมพันต้องอยู่ระหว่าง 10–500");
      p.bet = n;
      emit(r);
    } else if (a.type === "spots") {
      const n = Math.floor(+a.value);
      if (r.phase === "playing" || p.id === r.dealerId || n < 1 || n > 3)
        return fail("เลือกได้ 1–3 มือ");
      p.spots = n;
      emit(r);
    } else if (a.type === "start") {
      if (!["lobby", "result"].includes(r.phase)) return fail("เกมเริ่มแล้ว");
      if (p.id !== r.dealerId) return fail("เจ้ามือเท่านั้นที่เริ่มได้");
      if (r.players.length < 2) return fail("ต้องมีผู้เล่นอย่างน้อย 1 คน");
      r.deck = newDeck();
      r.round++;
      r.phase = "playing";
      r.queue = [];
      r.players.forEach((x) => {
        x.hands =
          x.id === r.dealerId
            ? [makeHand(0)]
            : Array.from({ length: x.spots }, () => makeHand(x.bet));
        for (const h of x.hands) h.cards = [r.deck.pop(), r.deck.pop()];
      });
      for (const x of r.players.filter((x) => x.id !== r.dealerId))
        for (const h of x.hands) r.queue.push({ playerId: x.id, handId: h.id });
      r.queue.push({
        playerId: r.dealerId,
        handId: playerOf(r, r.dealerId).hands[0].id,
      });
      r.turn = 0;
      r.message = `ตาของ ${playerOf(r, current(r).playerId).name}`;
      emit(r);
    } else if (["hit", "stand", "double", "split"].includes(a.type)) {
      const q = current(r),
        h = handOf(r, q);
      if (!q || q.playerId !== p.id) return fail("ยังไม่ถึงตาของคุณ");
      const isDealer = p.id === r.dealerId;
      if (a.type === "hit") {
        if (isDealer && score(h) >= 17)
          return fail("เจ้ามือต้องหยุดเมื่อแต้มตั้งแต่ 17");
        h.cards.push(r.deck.pop());
        if (score(h) >= 21) {
          h.done = true;
          isDealer ? finish(r) : advance(r);
        } else emit(r);
      } else if (a.type === "stand") {
        if (isDealer && score(h) < 17) return fail("เจ้ามือต้องจั่วจนถึง 17");
        h.done = true;
        isDealer ? finish(r) : advance(r);
      } else if (a.type === "double") {
        if (isDealer || h.cards.length !== 2 || h.bet * 2 > 1000)
          return fail("Double ไม่ได้");
        h.bet *= 2;
        h.doubled = true;
        h.cards.push(r.deck.pop());
        h.done = true;
        advance(r);
      } else {
        if (
          isDealer ||
          h.split ||
          h.cards.length !== 2 ||
          cardValue(h.cards[0]) !== cardValue(h.cards[1]) ||
          p.hands.length >= 6
        )
          return fail("Split ไม่ได้");
        const c = h.cards.pop(),
          nh = makeHand(h.bet);
        h.split = true;
        nh.split = true;
        nh.cards = [c, r.deck.pop()];
        h.cards.push(r.deck.pop());
        p.hands.splice(p.hands.indexOf(h) + 1, 0, nh);
        r.queue.splice(r.turn + 1, 0, { playerId: p.id, handId: nh.id });
        emit(r);
      }
    } else if (a.type === "reset") {
      if (r.phase !== "result" || p.id !== r.dealerId)
        return fail("เจ้ามือเท่านั้นที่เตรียมขาใหม่ได้");
      r.phase = "lobby";
      r.players.forEach((x) => (x.hands = []));
      r.message = "วางเดิมพันและเลือกจำนวนมือ";
      emit(r);
    } else return fail("คำสั่งไม่ถูกต้อง");
    cb({ ok: true });
  });
  socket.on("disconnect", () => {
    const r = rooms.get(socket.data?.code),
      p = r && playerOf(r, socket.data.id);
    if (p) {
      p.offline = true;
      emit(r);
    }
  });
});

const root = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(root, "dist")));
app.use((req, res) => res.sendFile(path.join(root, "dist/index.html")));
http.listen(process.env.PORT || 3001, () =>
  console.log("Blackjack server ready"),
);
