/* ============================================================
   TAKURO v2 — en vivo (relay WebSocket + E2E) con respaldo local
   ============================================================ */
(() => {
  "use strict";

  const $ = (s) => document.querySelector(s);
  const LS_KEY = "takuro_v2";
  const CONFIG = window.TK_CONFIG || { relay: "" };
  let LIVE_MODE = !!CONFIG.relay && typeof Live !== "undefined";

  /* ---------------- utilidades ---------------- */
  const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
  function hashStr(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return Math.abs(h);
  }
  function rng(seed) {
    let a = hashStr(seed) || 12345;
    return function () {
      a |= 0; a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const pick = (arr, r) => arr[Math.floor(r() * arr.length)];
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /* ---------------- estado local ---------------- */
  const defaults = () => ({
    name: "", id: "", seed: "", pfp: null,
    wall: [],
    wallets: { diario: 100, kuro: 0 },
    lastRefill: 0,
    dayKey: "", redeemedToDay: 0,
    blocked: {}, // id -> alias (registro de bloqueo)
    chats: {}, idToAlias: {},
    pin: "", quiet: true,
    zone: "Centro Histórico", radius: 15,
    premium: false, curRoom: "chisme", groups: [],
  });

  let S;
  function save() { try { localStorage.setItem(LS_KEY, JSON.stringify(S)); } catch (e) {} }
  function load() {
    S = defaults();
    try {
      const raw = JSON.parse(localStorage.getItem(LS_KEY));
      Object.assign(S, raw, { wallets: Object.assign(defaults().wallets, (raw || {}).wallets) });
    } catch (e) {}
    if (!S.id) newIdentity();
  }
  function newIdentity() {
    S.seed = uid();
    S.id = "u_" + hashStr(S.seed).toString(36);
    save();
  }

  /* ---------------- zonas ---------------- */
  const ZONES = [
    { name: "Centro Histórico", lat: 19.4326, lng: -99.1332 },
    { name: "Universidad", lat: 19.3294, lng: -99.1862 },
    { name: "Zona Rosa", lat: 19.4250, lng: -99.1626 },
    { name: "Barrio Viejo", lat: 18.4814, lng: -69.9364 },
    { name: "Costa", lat: 21.1619, lng: -86.8515 },
  ];
  const ZONE_NAMES = ZONES.map((z) => z.name);
  function nearestZone(lat, lng) {
    let near = ZONES[0], best = Infinity;
    ZONES.forEach((z) => {
      const d = Math.abs(z.lat - lat) + Math.abs(z.lng - lng);
      if (d < best) { best = d; near = z; }
    });
    return near;
  }
  function getLoc(onOk, onFail) {
    // PRIVACIDAD: las coordenadas exactas (lat/lng) NUNCA salen del dispositivo.
    // Solo se convierten aquí en una ZONA aproximada, que es lo único que viaja por la red.
    if (!navigator.geolocation) { onFail(new Error("no-gps")); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        S.lat = pos.coords.latitude;
        S.lng = pos.coords.longitude;
        save();
        onOk(pos);
      },
      (err) => onFail(err),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  }

  /* ---------------- salas generales OBLIGATORIAS ---------------- */
  const ROOMS = [
    { key: "chisme", name: "Muros que Oyen", tag: "chisme general", emoji: "🗣" },
    { key: "ligar", name: "La Casa del Té", tag: "ligar", emoji: "🍵" },
    { key: "plaza", name: "El Mercado", tag: "temas generales", emoji: "🗞" },
    { key: "refugio", name: "El Refugio", tag: "sala global · sin zona", emoji: "🏮", global: true },
  ];
  const roomByKey = (k) => ROOMS.find((r) => r.key === k) || ROOMS[0];
  const RADIO_MIN = 2;
  const radioMax = () => (S.premium ? 50 : 20); // Normal: 20 km · Discreta+: 50 km

  /* ---------------- bots ---------------- */
  const BOT_NAMES = ["Eco", "Sombra", "Kuro", "Linfa", "Ceniza", "Neblina", "Aurora", "Blackout", "Faro", "Bruma", "Mirlo", "Opio", "Zafiro", "Cripta", "Vela", "Selene", "Nyx", "Umbra", "Cedro", "Fénix"];
  const BOT_LINES = [
    "Alguien anda en una terraza mirando el mismo cielo que yo 👀",
    "¿Alguien más se aburrió de las apps normales donde todos te vigilan?",
    "Busco gente nocturna para café y charla larga.",
    "Si lees esto y estás en esta zona, hoy es buen día para perder el miedo.",
    "Silencio en la ciudad… pero la noche habla.",
    "Primera vez aquí. Me dijeron que nadie sabe quién eres. Me gusta.",
    "¿Alguien en condición de jugar un dominó rápido esta semana?",
    "Restaurante que recomienden con luz tenue y buena música.",
    "Me gusta la gente que habla poco y dice mucho.",
    "¿Se fijaron que a esta hora la niebla se ve violeta?",
    "Dejé todo por venir a probar esto. No me arrepiento.",
    "Gente que escribe bien me atrae más que fotos. Aquí que gane el texto.",
    "Esa música que suena a lo lejos… alguien debe saber de donde viene.",
    "Anónimo pero honesto: vengo a encontrarme con alguien real.",
    "La discreción es un arte. Este lugar la entiende.",
    "Una partida de tres en raya y platicamos, ¿va?",
    "Se buscan almas nocturnas, sin fotos, sin ataduras.",
    "La mejor conversación comienza por algo que no esperas leer.",
    "Si lo ves en el radar, es porque está despierto a esta hora.",
    "Todos tenemos un secreto. Hoy decidí soltar uno: me gusta silbar mientras camino.",
  ];
  const BOT_REPLIES = [
    "Me gusta cómo piensas.",
    "Eso estuvo interesante… dime más.",
    "Jaja, nunca esperé leer eso hoy.",
    "¿Y dónde sueles perderte cuando nadie te busca?",
    "Eres más directo que el radar. Bien.",
    "¿Texto o voz? Aquí parece que manda el texto.",
    "Prometiste una conversación como la antigua. Sigo aquí.",
    "No sé quién eres, pero me caes bien.",
    "¿Partida de tres en raya y después seguimos hablando?",
    "La noche tiene razones para los que no duermen.",
    "Eso deja claro que sabes mantener secretos.",
    "Interesante. Muy interesante.",
  ];

  let bots = [];

  function makeBots() {
    bots = [];
    const r = rng("takuro-world");
    ZONE_NAMES.forEach((zn, zi) => {
      const count = 5 + Math.floor(r() * 5);
      for (let i = 0; i < count; i++) {
        const name = BOT_NAMES[(zi * 11 + i) % BOT_NAMES.length] + (hashStr(zn + i) % 7 === 0 ? " " + (97 + (hashStr(zn + i) % 5)) : "");
        bots.push({
          id: "sim_" + hashStr(zn + "|" + i).toString(36),
          zone: zn,
          name,
          karma: Math.floor(r() * 900) + 50,
          mood: 0.5 + r(),
          dist: 1.5 + r() * 58, // km desde TÚ (el centro es cada dispositivo)
          r,
        });
      }
    });
  }

  /* ---------------- feed de salas ---------------- */
  let feed = []; // {id, botId, author, text, ttl, at, expiresAt, up, down, myVote, pin, mine, room}
  function botByAlias(id, name) { S.idToAlias[id] = name; }

  function inPerimeter(b) {
    return !S.blocked[b.id] && b.dist <= S.radius;
  }
  function zoneBots() { return bots.filter((b) => b.zone === S.zone && inPerimeter(b)); }

  function postText(text, ttl, botId, author, mine, room) {
    if (LIVE_MODE) {
      const item = {
        id: uid(), botId: null, author,
        text, ttl, at: Date.now(),
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
        likes: 0, up: 0, down: 0,
        myVote: 0, pin: false, liked: false, mine: true,
        room: (mine ? S.curRoom : (room || S.curRoom)),
      };
      feed.unshift(item);
      pendingPosts[item.id] = Date.now();
      renderFeed();
      Live.post(S.curRoom, text, ttl, item.id);
      return;
    }
    const item = {
      id: uid(), botId: botId || null, author,
      text, ttl, at: Date.now(),
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
      likes: mine ? 0 : Math.floor(Math.random() * 120),
      up: mine ? 0 : Math.floor(Math.random() * 40),
      down: mine ? 0 : Math.floor(Math.random() * 6),
      myVote: 0, pin: false,
      liked: false, mine: !!mine,
      room: (mine ? S.curRoom : (room || S.curRoom)),
    };
    feed.unshift(item);
    save();
    renderFeed();
  }

  function seedRooms() {
    if (LIVE_MODE) return;
    if (feed.length > 0) return;
    ROOMS.forEach((r, ri) => {
      const n = 3 + (hashStr(S.id + r.key) % 3);
      for (let i = 0; i < n; i++) {
        const b = pick(bots, Math.random);
        if (!b) continue;
        const ttl = [0, 1800, 3600, 86400][hashStr(S.id + r.key + i) % 4];
        postText(pick(BOT_LINES, Math.random), ttl, b.id, b.name, false, r.key);
      }
    });
  }

  function botPostTick() {
    if (LIVE_MODE) return;
    const list = zoneBots();
    if (!list.length) return;
    if (Math.random() < 0.7) {
      const b = pick(list, Math.random);
      const room = pick(ROOMS, Math.random).key;
      postText(pick(BOT_LINES, Math.random), 900, b.id, b.name, false, room);
    }
    // likes simulados acelerados sobre posts propios (demo de la regla de recompensa)
    feed.forEach((f) => {
      if (f.mine) {
        f.likes += Math.floor(Math.random() * 25);
        maybeRewardMine(f);
      }
    });
    renderFeed();
  }
  function maybeRewardMine(f) {
    if (!f.mine || f.likes < 500) return;
    const day = new Date().toDateString();
    if (S.dayKey !== day) { S.dayKey = day; S.redeemedToDay = 0; }
    if (S.redeemedToDay >= 10) return;
    const reward = 10;
    S.wallets.kuro += reward;
    S.redeemedToDay++;
    f.likes = 0; // reinicia el contador (ya premio usado)
    save();
    toast("Tu mensaje pasó de 500 ✓ +" + reward + " Kuro (diario: " + S.redeemedToDay + "/10)");
  }

  /* ---------------- tick principal ---------------- */
  function tick() {
    const now = Date.now();
    if (LIVE_MODE) {
      Object.keys(pendingPosts).forEach((id) => { if (now - pendingPosts[id] > 60000) delete pendingPosts[id]; });
    }
    feed = feed.filter((f) => !f.expiresAt || f.expiresAt > now);
    Object.keys(S.chats).forEach((id) => {
      const c = S.chats[id];
      if (!c) return;
      c.msgs = c.msgs.filter((m) => !m.expiresAt || m.expiresAt > now || (m.tabula && !m.broken));
    });
    S.groups.forEach((g) => { g.msgs = g.msgs.filter((m) => !m.expiresAt || m.expiresAt > now); });
    renderFeed(); renderChatList(); if (currentPeer) renderChat(); if (currentGroup) renderGroupChat();
    document.querySelectorAll("[data-ttl]").forEach((el) => {
      const exp = Number(el.getAttribute("data-ttl"));
      if (!exp) return;
      const remaining = Math.max(0, exp - now);
      const fill = el.querySelector(".ttl-fill");
      if (fill) fill.style.width = Math.min(100, (remaining / (Number(el.getAttribute("data-dur")) * 1000)) * 100) + "%";
    });
    checkReturnedBlocked();
  }

  const blockedReturnTimers = {};
  function checkReturnedBlocked() {
    const now = Date.now();
    Object.keys(S.blocked).forEach((id) => {
      if (!blockedReturnTimers[id]) blockedReturnTimers[id] = now + 40000 + Math.random() * 30000;
      if (blockedReturnTimers[id] < now) {
        blockedReturnTimers[id] = now + 120000;
        const fakeAlias = pick(BOT_NAMES, Math.random);
        toast("«" + S.blocked[id] + "» volvió como «" + fakeAlias + "». Seguía bloqueado por tu identidad criptográfica.");
      }
    });
  }

  /* ---------------- render: radar ---------------- */
  let sweep = 0;
  const canvas = $("#radar-canvas");
  const ctx = canvas.getContext("2d");

  function blipPos(seed, rnd, dist) {
    const r = rng(seed);
    const ang = r() * Math.PI * 2;
    const frac = Math.min(1, dist / Math.max(2, S.radius));
    const rad = 0.1 + frac * 0.8;
    return { x: 150 + Math.cos(ang) * rad * 135, y: 150 + Math.sin(ang) * rad * 135, ang, dist };
  }

  function renderRadar() {
    ctx.clearRect(0, 0, 300, 300);
    ctx.strokeStyle = "rgba(230,126,34,0.18)";
    ctx.lineWidth = 1;
    [40, 80, 120, 150].forEach((rr) => {
      ctx.beginPath(); ctx.arc(150, 150, rr, 0, Math.PI * 2); ctx.stroke();
    });
    const grad = ctx.createConicGradient ? null : null;
    ctx.save();
    ctx.beginPath(); ctx.clip();
    if (ctx.createConicGradient) {
      const g = ctx.createConicGradient(sweep, 150, 150);
      g.addColorStop(0, "rgba(230,126,34,0.32)");
      g.addColorStop(0.25, "rgba(230,126,34,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(150, 150); ctx.arc(150, 150, 150, sweep, sweep + 0.5); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    // punto central (yo)
    ctx.beginPath(); ctx.arc(150, 150, 6, 0, Math.PI * 2); ctx.fillStyle = "#2ecc71"; ctx.fill();
    sweep += 0.02;
    requestAnimationFrame(renderRadar);
  }

  function renderBlips() {
    const wrap = $("#nearby-users");
    wrap.innerHTML = "";
    if (LIVE_MODE) {
      const list = Live.peers();
      list.slice(0, 12).forEach((b, i) => {
        const dist = 0.6 + (Math.abs(hashStr(b.name)) % 100) / 100 * Math.max(1, S.radius - 1);
        const p = blipPos("live_" + b.name, Math.random, dist);
        const el = document.createElement("button");
        el.className = "blip";
        el.style.left = p.x + "px";
        el.style.top = p.y + "px";
        el.textContent = b.name.charAt(0).toUpperCase();
        el.title = b.name;
        el.addEventListener("click", (e) => { e.stopPropagation(); openProfile(b.id); });
        wrap.appendChild(el);
      });
      return;
    }
    zoneBots().slice(0, 8).forEach((b) => {
      const p = blipPos(b.id, b.r, b.dist);
      const el = document.createElement("button");
      el.className = "blip";
      el.style.left = p.x + "px";
      el.style.top = p.y + "px";
      el.textContent = b.name.charAt(0).toUpperCase();
      el.title = b.name;
      el.addEventListener("click", (e) => { e.stopPropagation(); openProfile(b.id); });
      wrap.appendChild(el);
    });
  }

  /* ---------------- render: feed de la sala abierta ---------------- */
  function renderFeed() {
    const box = $("#room-msgs");
    if (!box) return;
    const list = feed.filter((f) => {
      if (f.room && f.room !== S.curRoom) return false;
      const b = f.botId ? bots.find((x) => x.id === f.botId) : null;
      if (f.botId && S.blocked[f.botId]) return false;
      if (f.botId && (!b || b.zone !== S.zone || !inPerimeter(b))) return false;
      return true;
    }).sort((a, b) => ((b.pin ? 1 : 0) - (a.pin ? 1 : 0)) || (b.at - a.at));
    const tag = $("#room-head-tag");
    if (tag) {
      if (S.curRoom === "refugio") {
        tag.textContent = "sala global · la oyen todos, sin importar la zona";
      } else {
        let txt = list.length + " vivos en tu perímetro (" + S.radius + " km";
        if (!S.premium) txt += " · máx 20 · Discreta+ 50";
        txt += ")";
        tag.textContent = txt;
      }
    }
    box.innerHTML = list.map((f) => {
      const who = f.mine ? "Tú (" + esc(S.name) + ")" : esc(f.author);
      const pinned = !!f.pin;
      const ttlBar = !pinned && f.ttl > 0;
      return (
        '<article class="msg' + (pinned ? " is-pinned" : "") + '">' +
        (pinned ? '<div class="msg-pin">📌 Fijado por la comunidad</div>' : "") +
        '<div class="msg-head"><span class="msg-author">' + who + '</span><span class="msg-time">' + age(f.at) + '</span></div>' +
        '<div class="msg-body">' + esc(f.text) + '</div>' +
        '<div class="msg-exp">' +
        '<button class="vote-btn' + (f.myVote === 1 ? " is-on" : "") + '" data-vup="' + f.id + '">▲ ' + f.up + '</button>' +
        '<button class="vote-btn down' + (f.myVote === -1 ? " is-on" : "") + '" data-vdown="' + f.id + '">▼ ' + f.down + '</button>' +
        '<span class="ttl-hint">' + (pinned ? "permanente · fijado" : (ttlBar ? "se apaga en " + human(remaining(f)) : "permanente")) + '</span>' +
        '</div>' +
        (ttlBar ? '<div class="ttl-bar"><div class="ttl-fill" data-ttl="' + f.expiresAt + '" data-dur="' + f.ttl + '" style="width:100%"></div></div>' : "") +
        '</article>'
      );
    }).join("") || '<p class="muted pad">La zona está en silencio. Lanza algo al viento.</p>';

    box.querySelectorAll("[data-vup]").forEach((btn) => {
      btn.addEventListener("click", () => voteOn(btn.getAttribute("data-vup"), 1));
    });
    box.querySelectorAll("[data-vdown]").forEach((btn) => {
      btn.addEventListener("click", () => voteOn(btn.getAttribute("data-vdown"), -1));
    });
  }
  function voteOn(id, v) {
    const f = feed.find((x) => x.id === id);
    if (!f) return;
    if (LIVE_MODE) {
      const target = f.myVote === v ? 0 : v;
      f.myVote = target;
      Live.vote(id, target);
      return;
    }
    if (f.myVote === v) {
      f.myVote = 0;
      if (v === 1) f.up = Math.max(0, f.up - 1); else f.down = Math.max(0, f.down - 1);
    } else {
      if (f.myVote === 1) f.up = Math.max(0, f.up - 1);
      if (f.myVote === -1) f.down = Math.max(0, f.down - 1);
      f.myVote = v;
      if (v === 1) f.up++; else f.down++;
    }
    if (f.down > 50) {
      feed = feed.filter((x) => x.id !== f.id);
      renderFeed();
      toast("Mensaje eliminado por la comunidad (más de 50 ▼).");
      return;
    }
    if (f.up > 50 && !f.pin) {
      f.pin = true;
      f.expiresAt = 0;
      toast("Mensaje fijado por la comunidad (más de 50 ▲).");
    }
    renderFeed();
  }
  const remaining = (f) => f.expiresAt - Date.now();
  function age(ts) {
    const d = Date.now() - ts;
    if (d < 60000) return "ahora";
    if (d < 3600000) return Math.floor(d / 60000) + "m";
    return Math.floor(d / 3600000) + "h";
  }
  function human(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return s + "s";
    if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
    return Math.floor(s / 3600) + "h";
  }

  /* ---------------- salas ---------------- */
  function renderRoomTabs() {
    const box = $("#room-tabs");
    box.innerHTML = ROOMS.map((r) =>
      '<button class="room-tab' + (r.key === S.curRoom ? " is-active" : "") + '" data-room="' + r.key + '">' +
      '<span class="room-emoji">' + r.emoji + '</span><span class="room-name">' + esc(r.name) + '</span>' +
      (r.global ? '<span class="badge-live">global</span>' : '') +
      '<span class="room-tag">' + esc(r.tag) + '</span></button>'
    ).join("");
    box.querySelectorAll("[data-room]").forEach((el) => {
      el.addEventListener("click", () => {
        setRoom(el.getAttribute("data-room"));
        openRoom();
      });
    });
    const cur = roomByKey(S.curRoom);
    const title = $("#room-head-title");
    if (title) title.textContent = cur.emoji + " " + cur.name;
    const ph = $("#room-input");
    if (ph) ph.placeholder = "Lanzar algo al " + cur.name.toLowerCase() + "…";
  }
  function setRoom(key) {
    if (LIVE_MODE) {
      if (S.curRoom && S.curRoom !== key) Live.unsub(S.curRoom);
      Live.sub(key);
    }
    S.curRoom = key;
    save();
    renderRoomTabs();
    renderFeed();
  }
  function openRoom() {
    renderRoomTabs();
    const rv = $("#room-view");
    if (rv) rv.classList.remove("hidden");
    renderFeed();
  }
  function closeRoom() {
    const rv = $("#room-view");
    if (rv) rv.classList.add("hidden");
  }

  /* ---------------- perímetro: radio por membresía ---------------- */
  function renderPerimetro() {
    const range = $("#radius-range");
    if (!range) return;
    const max = radioMax();
    if (S.radius > max) S.radius = max;
    range.min = RADIO_MIN;
    range.max = max;
    range.value = S.radius;
    const lbl = $("#radius-label");
    if (lbl) lbl.textContent = "Perímetro (TÚ eres el centro) · " + (S.premium ? "Discreta+: hasta 50 km" : "Normal: hasta 20 km");
    $("#radius-value").textContent = S.radius + " km";
    const chip = $("#membership-chip");
    if (chip) {
      chip.innerHTML = S.premium
        ? '🅣 Discreta+ <span class="muted small">(perímetro 50 km)</span>'
        : 'Normal <span class="muted small">(perímetro 20 km · mejora a Discreta+ para 50)</span>';
    }
  }

  /* ---------------- grupos con condiciones ---------------- */
  function renderGroups() {
    const box = $("#group-list");
    if (!box) return;
    $("#groups-empty").classList.toggle("hidden", S.groups.length > 0);
    box.innerHTML = S.groups.map((g, i) =>
      '<div class="group-item" data-gi="' + i + '">' +
      '<div class="avatar">' + esc((g.name || "G").charAt(0).toUpperCase()) + '</div>' +
      '<div style="flex:1"><div class="chat-name">' + esc(g.name) + '</div>' +
      '<div class="chat-last">' + (g.cond === "rango" ? "Por rango · " + g.radius + " km" : "Por invitación · código") +
      ' · ' + g.members.length + ' miembros</div></div>' +
      '<button class="btn btn-ghost" data-share="' + i + '">Copiar</button>' +
      '</div>'
    ).join("");
    box.querySelectorAll("[data-gi]").forEach((el) => {
      el.addEventListener("click", (e) => {
        if (e.target.closest("[data-share]")) return;
        openGroup(Number(el.getAttribute("data-gi")));
      });
    });
    box.querySelectorAll("[data-share]").forEach((el) => {
      el.addEventListener("click", async (e) => {
        e.stopPropagation();
        const g = S.groups[Number(el.getAttribute("data-share"))];
        const txt = "Takuro · Únete al grupo «" + g.name + "» con el código: TK-" + g.code;
        try { await navigator.clipboard.writeText(txt); toast("Código copiado: TK-" + g.code); }
        catch (err) { toast("Código de invitación: TK-" + g.code); }
      });
    });
  }
  function groupCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let c = "";
    for (let i = 0; i < 5; i++) c += chars[Math.floor(Math.random() * chars.length)];
    return c;
  }
  function createGroup() {
    const name = $("#grp-name").value.trim();
    if (name.length < 2) { toast("Nombre del grupo: mínimo 2 caracteres."); return; }
    const cost = 250;
    const total = S.wallets.diario + S.wallets.kuro;
    if (total < cost) { toast("Crear grupo cuesta 250 Takus. No tienes suficientes."); return; }
    const cond = $("#grp-cond").value;
    const radius = Number($("#grp-radius").value || 10);
    if (LIVE_MODE) {
      pendingGroupForm = {
        name, cond,
        radius: cond === "rango" ? radius : 0,
        members: [S.name], owner: S.name, msgs: [], live: true,
      };
      $("#group-form").classList.add("hidden");
      renderGroups();
      Live.createGroup(name, cond, radius);
      toast("Creando grupo en el relay… (se cobra 250 Takus)");
      return;
    }
    const g = {
      id: "grp_" + uid(), name,
      cond, radius: cond === "rango" ? radius : 0,
      code: groupCode(),
      members: [S.name],
      owner: S.name,
      msgs: [],
    };
    let rest = cost;
    const fromDiario = Math.min(S.wallets.diario, rest);
    S.wallets.diario -= fromDiario; rest -= fromDiario;
    if (rest > 0) S.wallets.kuro -= rest;
    S.groups.push(g);
    save();
    $("#group-form").classList.add("hidden");
    renderGroups(); renderWallets();
    toast("Grupo creado. Código de invitación: TK-" + g.code);
  }
  function joinByCode() {
    const raw = $("#grp-code-input").value.trim().toUpperCase().replace(/^TK-/, "");
    if (raw.length < 4) { toast("Pega un código TK-XXXXX válido."); return; }
    if (LIVE_MODE) {
      $("#grp-code-input").value = "";
      Live.joinGroup(raw);
      toast("Enviando código al relay…");
      return;
    }
    const g = S.groups.find((x) => x.code === raw);
    if (g) {
      if (!g.members.includes(S.name)) g.members.push(S.name);
      save(); renderGroups();
      toast("Ya estás dentro de «" + g.name + "».");
      return;
    }
    // demo: un grupo externo de simulación (no se puede verificar fuera del dispositivo)
    const ext = {
      id: "grp_ext_" + uid(), name: "Grupo externo TK-" + raw,
      cond: "rango", radius: 10, code: raw,
      members: [S.name, "2 invitados…"], owner: "otros",
      msgs: [{ id: uid(), from: "peers", name: "Invitado", text: "Hola. Código válido (demo). La verificación real llega con el relay.", at: Date.now(), ttl: 0 }],
    };
    S.groups.push(ext);
    save(); renderGroups();
    toast("Unido por código (demo). Apertura real en F1.");
  }
  let currentGroup = null;
  let pendingGroupForm = null;
  function openGroup(index) {
    const g = S.groups[index];
    if (!g) return;
    currentGroup = g;
    $("#group-peer-name").textContent = g.name + " (" + g.members.length + ")";
    $("#group-view").classList.remove("hidden");
    renderGroupChat();
  }
  function renderGroupChat() {
    if (!currentGroup) return;
    const box = $("#group-messages");
    box.innerHTML = currentGroup.msgs.map((ms) => {
      const me = ms.name === S.name;
      const bubbleCls = me ? "me" : "peer";
      const meta = '<div class="bubble-meta">' + esc(ms.name) + " · " + age(ms.at) +
        (ms.ttl > 0 ? " · se apaga en " + human(ms.expiresAt - Date.now()) : " · permanente") + '</div>';
      return '<div class="bubble ' + bubbleCls + '">' + esc(ms.text) + meta + '</div>';
    }).join("") || '<p class="muted pad">Aún no hay mensajes. Lanza el primero.</p>';
    box.scrollTop = box.scrollHeight;
  }
  function sendGroup() {
    if (!currentGroup) return;
    const input = $("#group-input");
    const text = input.value.trim();
    if (!text) return;
    const ttl = Number($("#group-ttl").value);
    if (currentGroup.live) {
      Live.groupMsg(currentGroup.id, text, ttl);
      input.value = "";
      return;
    }
    const ms = {
      id: uid(), name: S.name, text,
      at: Date.now(), ttl,
      expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
    };
    currentGroup.msgs.push(ms);
    input.value = "";
    save();
    renderGroupChat();
    scheduleGroupReply();
  }
  function scheduleGroupReply() {
    if (currentGroup && currentGroup.live) return;
    const g = currentGroup;
    if (!g) return;
    setTimeout(() => {
      if (currentGroup !== g) { renderGroups(); return; }
      const others = g.members.filter((m) => m !== S.name);
      const who = (others.length ? pick(others, Math.random) : "Invitado") || "Invitado";
      const ttl = Math.random() < 0.5 ? 3600 : 0;
      g.msgs.push({
        id: uid(), name: who, text: pick(BOT_REPLIES, Math.random),
        at: Date.now(), ttl,
        expiresAt: ttl > 0 ? Date.now() + ttl * 1000 : 0,
      });
      save();
      if (currentGroup === g) renderGroupChat();
      renderGroups();
    }, 1400 + Math.random() * 2600);
  }

  /* ---------------- render: chats ---------------- */
  let currentPeer = null;

  function chatIds() { return Object.keys(S.chats).filter((id) => !S.blocked[id]); }

  function renderChatList() {
    const ids = chatIds();
    const box = $("#chat-list");
    $("#chats-empty").classList.toggle("hidden", ids.length > 0);
    box.innerHTML = ids.map((id) => {
      const c = S.chats[id];
      const last = c.msgs[c.msgs.length - 1];
      const nm = S.idToAlias[id] || c.name || "Alguien";
      return (
        '<div class="chat-item" data-chatid="' + id + '">' +
        '<div class="avatar">' + esc(nm.charAt(0).toUpperCase()) + '</div>' +
        '<div style="flex:1"><div class="chat-name">' + esc(nm) + '</div>' +
        '<div class="chat-last">' + (last ? esc(last.text || (last.img ? "[imagen]" : "[sello]")) : "Di algo…") + '</div></div>' +
        '</div>'
      );
    }).join("");
    box.querySelectorAll("[data-chatid]").forEach((el) => {
      el.addEventListener("click", () => openChat(el.getAttribute("data-chatid")));
    });
  }

  /* ---------------- render: takus ---------------- */
  function renderWallets() {
    $("#wallet-diario").textContent = S.wallets.diario;
    $("#wallet-kuro").textContent = S.wallets.kuro;
  }
  const SHOP = [
    { label: "Crear un grupo (sala admin)", price: 250 },
    { label: "Baliza premium en el radar", price: 75 },
    { label: "Cosmético para tu muro", price: 150 },
    { label: "Torneo express de dominó", price: 100 },
  ];
  function renderShop() {
    $("#takus-shop").innerHTML = SHOP.map((s, i) =>
      '<div class="shop-item"><span>' + esc(s.label) + '</span>' +
      '<button class="btn btn-ghost" data-buy="' + i + '"><span class="price">' + s.price + '</span></button></div>'
    ).join("");
    document.querySelectorAll("[data-buy]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const item = SHOP[Number(btn.getAttribute("data-buy"))];
        buy(item);
      });
    });
  }
  function buy(item) {
    const total = S.wallets.diario + S.wallets.kuro;
    if (total < item.price) { toast("No tienes suficientes Takus."); return; }
    let rest = item.price;
    const fromDiario = Math.min(S.wallets.diario, rest);
    S.wallets.diario -= fromDiario; rest -= fromDiario;
    if (rest > 0) { S.wallets.kuro -= rest; }
    save();
    renderWallets();
    toast("Cobrado. " + item.label + " (demo)");
  }
  function doDailyRefill() {
    if (LIVE_MODE) {
      Live.refreshWallet();
      toast("Monedero actualizado. En modo en vivo el piso (⇢ 100) lo aplica el relay cada 24 h.");
      return;
    }
    const day = new Date().toDateString();
    const last = new Date(S.lastRefill).toDateString();
    if (last === day) { toast("Ya recargaste hoy. Regresa mañana."); return; }
    S.lastRefill = Date.now();
    if (S.wallets.diario < 100) {
      const add = 100 - S.wallets.diario;
      S.wallets.diario = 100;
      save();
      toast("El piso te completó +" + add + " Takus (diario => 100)");
    } else {
      toast("Tu monedero Sombra ya está sobre 100. No hay recarga hoy (regla del piso).");
    }
    save();
    renderWallets();
  }

  /* ---------------- render: perfil propio ---------------- */
  function renderMe() {
    $("#me-name").textContent = S.name || "—";
    $("#me-id").textContent = "ID: " + S.id.slice(0, 10) + "… (criptográfico)";
    const karma = Object.keys(bots).length * 12;
    $("#me-karma").textContent = "Karma: " + karma;
    const av = $("#me-avatar");
    if (S.pfp) { av.innerHTML = '<img src="' + S.pfp + '"/>'; } else { av.textContent = (S.name || "?").charAt(0).toUpperCase(); }
    renderMyWall();
  }
  function renderMyWall() {
    const box = $("#my-wall");
    box.innerHTML = S.wall.map((w) =>
      '<div class="wall-tile' + (w.mode === "hidden" ? " locked" : "") + '" data-w="' + w.id + '">' +
      (w.mode === "hidden" ? '<span class="lock-icon">"</span>' : '<img src="' + w.img + '"/>') +
      '<span class="badge-tag">' + (w.once ? "1 vista" : w.mode === "hidden" ? "oculta" : "pública") + '</span>' +
      '</div>'
    ).join("");
    box.querySelectorAll("[data-w]").forEach((el) => {
      el.addEventListener("click", () => {
        const w = S.wall.find((x) => x.id === el.getAttribute("data-w"));
        if (!w) return;
        w.mode = w.mode === "hidden" ? "public" : "hidden";
        save();
        renderMyWall();
        syncProfileToRelay();
        toast("Foto ahora: " + (w.mode === "hidden" ? "oculta (piden permiso)" : "pública · la ven en tu perfil"));
      });
    });
  }
  function demoTile() {
    const c = document.createElement("canvas");
    c.width = 200; c.height = 200;
    const g = c.getContext("2d");
    const hue = Math.floor(Math.random() * 360);
    const grad = g.createLinearGradient(0, 0, 200, 200);
    grad.addColorStop(0, "hsl(" + hue + ",55%,28%)");
    grad.addColorStop(1, "hsl(" + ((hue + 60) % 360) + ",50%,14%)");
    g.fillStyle = grad; g.fillRect(0, 0, 200, 200);
    g.fillStyle = "rgba(255,255,255,0.08)";
    g.beginPath(); g.arc(140, 60, 40, 0, Math.PI * 2); g.fill();
    g.beginPath(); g.arc(200, 200, 90, Math.PI, Math.PI * 1.6); g.fill();
    return c.toDataURL("image/jpeg", 0.8);
  }

  /* ---------------- perfil de un bot ---------------- */
  let sheetPeer = null;
  let sheetGranted = {}; // id -> set de fotos concedidas

  function wallForBot(b) {
    const r = rng(b.id + "wall");
    const n = 3 + Math.floor(r() * 4);
    const arr = [];
    for (let i = 0; i < n; i++) {
      arr.push({
        id: b.id + "_p" + i,
        mode: r() < 0.5 ? "hidden" : "public",
        once: r() < 0.3,
        img: demoTile(),
      });
    }
    return arr;
  }

  function botOf(id) {
  let b = bots.find((x) => x.id === id);
  if (!b && LIVE_MODE) b = livePeerAsBot(id);
  return b;
}

  function openProfile(botId) {
    const b = botOf(botId);
    if (!b) return;
    sheetPeer = b;
    if (!b.wall && !b.live) b.wall = wallForBot(b);
    $("#peer-name").textContent = b.name;
    $("#peer-karma").textContent = "Karma: " + b.karma;
    $("#peer-avatar").textContent = b.name.charAt(0).toUpperCase();
    const zone = ZONES.find((z) => z.name === b.zone);
    $("#peer-loc").textContent = "Zona: " + b.zone + (b.live ? " · misma zona que tú" : (zone ? " (radar " + S.radius + " km)" : ""));
    renderPeerWall();
    $("#profile-sheet").classList.remove("hidden");
    save();
    if (b.live) Live.profile(botId);
  }
  function renderPeerWall() {
    const box = $("#peer-wall");
    const b = sheetPeer;
    if (b.live) {
      if (!b.wall) {
        box.innerHTML = '<p class="muted small">Consultando su perfil público…</p>';
        $("#peer-wall-msg").textContent = "";
        return;
      }
      box.innerHTML = b.wall.map((w, i) =>
        '<div class="wall-tile" data-open="' + i + '"><img src="' + w + '"/><span class="badge-tag">pública</span></div>'
      ).join("");
      $("#peer-wall-msg").textContent = b.wall.length ? "" : "Muro sin fotos públicas.";
      box.querySelectorAll("[data-open]").forEach((el) => {
        el.addEventListener("click", (ev) => {
          ev.stopPropagation();
          openOnce(b.wall[Number(el.getAttribute("data-open"))]);
        });
      });
      return;
    }
    box.innerHTML = b.wall.map((w) => {
      const granted = sheetGranted[b.id] && sheetGranted[b.id].includes(w.id);
      if (w.mode === "hidden" && !granted) {
        return '<div class="wall-tile locked" data-req="' + w.id + '"><span class="lock-icon">"</span><button class="btn btn-ghost" data-req="' + w.id + '" style="position:absolute;inset:0;color:var(--brand2);font-size:11px;background:none;border:none;">Solicitar</button></div>';
      }
      return '<div class="wall-tile" data-open="' + w.id + '"><img src="' + w.img + '"/><span class="badge-tag">' + (w.once ? "1 vista" : "") + '</span></div>';
    }).join("");
    $("#peer-wall-msg").textContent = b.wall.length ? "" : "Muro vacío.";
    box.querySelectorAll("[data-req]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const w = b.wall.find((x) => x.id === el.getAttribute("data-req"));
        toast("Solicitud enviada a " + b.name + "…");
        setTimeout(() => {
          (sheetGranted[b.id] = sheetGranted[b.id] || []).push(w.id);
          if (w.once) { openOnce(w.img); }
          else toast(b.name + " te concedió ver esta foto.");
          renderPeerWall();
        }, 1800);
      });
    });
    box.querySelectorAll("[data-open]").forEach((el) => {
      el.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const w = b.wall.find((x) => x.id === el.getAttribute("data-open"));
        openOnce(w.img);
      });
    });
  }
  function openOnce(src) {
    $("#once-img").src = src;
    $("#once-box").classList.remove("hidden");
  }

  /* ---------------- chat privado ---------------- */
  function openChat(botId) {
    currentPeer = botId;
    const b = botOf(botId);
    const name = S.idToAlias[botId] || (b ? b.name : "Alguien");
    if (!S.chats[botId]) S.chats[botId] = { name, msgs: [] };
    $("#chat-peer-name").textContent = name;
    $("#chat-view").classList.remove("hidden");
    renderChat();
  }
  function renderChat() {
    if (!currentPeer) return;
    const c = S.chats[currentPeer];
    const box = $("#messages");
    box.innerHTML = c.msgs.map((m) => {
      const bubbleCls = m.from === "me" ? "me" : "peer";
      const sealed = m.tabula && !m.broken;
      const imgTag = m.img ? (m.once ? '<img src="' + m.img + '" data-once/>' : '<img src="' + m.img + '"/>') : "";
      const meta = '<div class="bubble-meta">' + age(m.at) +
        (m.ttl > 0 ? " · se apaga en " + human(m.expiresAt - Date.now()) : " · permanente") +
        (m.tabula ? ' <span class="tabula-tag">sello</span>' : "") +
        (m.once ? ' <span class="tabula-tag">1 vista</span>' : "") +
        '</div>';
      return '<div class="bubble ' + bubbleCls + (sealed ? " sealed" : "") + '" data-msg="' + m.id + '"' + (m.expiresAt ? ' data-ttl="' + m.expiresAt + '" data-dur="' + m.ttl + '"' : "") + '>' +
        imgTag + (m.text ? esc(m.text) : "") + meta + '</div>';
    }).join("");
    box.querySelectorAll("[data-msg]").forEach((el) => {
      const m = c.msgs.find((x) => x.id === el.getAttribute("data-msg"));
      if (!m) return;
      el.addEventListener("click", () => {
        if (m.img && m.once) { c.msgs = c.msgs.filter((x) => x.id !== m.id); openOnce(m.img); save(); renderChat(); return; }
        if (m.img) { openOnce(m.img); return; }
        if (m.tabula && !m.broken && m.from !== "me") { openSeal(m); }
      });
    });
    box.scrollTop = box.scrollHeight;
  }
  async function sendText() {
    if (!currentPeer) return;
    const input = $("#msg-input");
    const text = input.value.trim();
    if (LIVE_MODE) {
      if (!text) return;
      const p = Live.peer(currentPeer);
      const kp = window.__takuro_kp;
      if (!p || !p.pub || !kp) { toast(p ? "Ese usuario no compartió su llave aún." : "Solo puedes escribirle si sigue en línea."); return; }
      const packet = await Crypto.seal(kp, p.pub, text);
      if (!packet) { toast("No se pudo cifrar."); return; }
      const m = { id: uid(), from: "me", text, ttl: 0, at: Date.now(), tabula: false, once: false, broken: true, img: null };
      if (!S.chats[currentPeer]) S.chats[currentPeer] = { name: p.name, msgs: [] };
      S.chats[currentPeer].msgs.push(m);
      pendingDms[m.id] = currentPeer;
      Live.dm(currentPeer, packet, m.id);
      input.value = "";
      save();
      renderChat();
      return;
    }
    const ttl = Number($("#composer-ttl").value);
    const tabula = $("#composer-tabula").checked;
    const once = $("#composer-once").checked;
    if (!text && pendingImg == null) return;
    if (!text && pendingImg == null) return;
    const m = {
      id: uid(), from: "me", text: text || "",
      img: pendingImg, pendingImg: pendingImg = null,
      ttl: ttl > 0 ? Math.max(ttl, tabula ? 30 : ttl) : 0,
      at: Date.now(),
      tabula, once, broken: true,
    };
    if (m.ttl > 0) m.expiresAt = Date.now() + m.ttl * 1000;
    S.chats[currentPeer].msgs.push(m);
    input.value = "";
    $("#attach-input").value = "";
    save();
    renderChat();
    scheduleReply();
  }
  let pendingImg = null;
  let pendingPosts = {}; // id -> timestamp de envío (para revertir si el relay rechaza)
  let pendingDms = {};   // id del mensaje -> id del chat (para revertir si el relay rechaza)
  async function receiveDm(msg) {
    const kp = window.__takuro_kp;
    const p = Live.peer(msg.m.from);
    const pub = p && p.pub;
    const text = (pub && kp) ? await Crypto.open(kp, pub, { ct: msg.m.ct, iv: msg.m.iv }) : null;
    if (text == null) { toast("DM cifrado no descifrable."); return; }
    const id = msg.m.from;
    if (!S.chats[id]) S.chats[id] = { name: msg.m.from_name, msgs: [] };
    S.chats[id].name = msg.m.from_name;
    S.chats[id].msgs.push({ id: msg.m.id, from: "peer", text, ttl: 0, at: msg.m.at * 1000, tabula: false, once: false, broken: true, img: null });
    save();
    if (currentPeer === id) renderChat();
    renderChatList();
  }
  function scheduleReply() {
    if (LIVE_MODE) return;
    const peerId = currentPeer;
    setTimeout(() => {
      const c = S.chats[peerId];
      if (!c) return;
      const reply = pick(BOT_REPLIES, Math.random);
      const useTabula = Math.random() < 0.18;
      const m = {
        id: uid(), from: "peer", text: reply, img: null,
        ttl: useTabula ? 30 : (Math.random() < 0.6 ? 3600 : 0),
        at: Date.now(), tabula: useTabula, once: false, broken: !useTabula,
      };
      if (m.ttl > 0) m.expiresAt = Date.now() + m.ttl * 1000;
      c.msgs.push(m);
      save();
      if (currentPeer === peerId) renderChat();
      renderChatList();
    }, 1500 + Math.random() * 3000);
  }
  let sealTarget = null;
  function openSeal(m) {
    sealTarget = m;
    $("#seal-box").classList.remove("hidden");
  }
  function breakSeal() {
    if (!sealTarget) return;
    const m = sealTarget;
    m.broken = true;
    m.ttl = 30;
    m.expiresAt = Date.now() + 30000;
    save();
    toast("Sello roto. El mensaje se apaga en 30 s.");
    $("#seal-box").classList.add("hidden");
    sealTarget = null;
    renderChat();
  }

  /* ---------------- bloqueo ---------------- */
  function blockPeer() {
    if (!sheetPeer) return;
    const id = sheetPeer.id;
    S.blocked[id] = sheetPeer.name;
    feed = feed.filter((f) => f.botId !== id);
    save();
    $("#profile-sheet").classList.add("hidden");
    toast("Bloqueado por identidad criptográfica. Ni cambiando el nombre volverá.");
    renderFeed(); renderBlips(); renderChatList();
  }

  /* ---------------- navegación de vistas ---------------- */
  const VIEWS = ["radar", "chats", "groups", "takus", "profile"];
  function showView(v) {
    VIEWS.forEach((x) => $("#view-" + x).classList.toggle("hidden", x !== v));
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("is-active", b.dataset.view === v));
    if (v === "chats") renderChatList();
    if (v === "groups") renderGroups();
    if (v === "takus") { renderWallets(); renderShop(); }
    if (v === "profile") renderMe();
  }

  /* ---------------- flip puerta / onboarding ---------------- */
  function enter() {
    $("#gate").classList.add("hidden");
    const app = $("#app");
    app.classList.remove("hidden");
    showView("radar");
    updateZoneLabels();
    renderPerimetro();
    renderRoomTabs();
    $("#me-name").textContent = S.name;
    $("#opt-premium").checked = S.premium;
    renderRadarWrap();
    renderFeed(); renderWallets(); renderGroups();
    if (LIVE_MODE) {
      if (window.__takuro_kp) Live.setInfo(S.name, S.zone, S.radius, window.__takuro_kp.pubB64);
      Live.sub(S.curRoom);
      Live.requestPresence();
    }
  }
  function updateZoneLabels() {
    const txt = "Zona: " + (S.zone || "según tu ubicación") + " · según tu ubicación";
    const zl = $("#zone-label"); if (zl) zl.textContent = txt;
    const zh = $("#zone-here"); if (zh) zh.textContent = txt;
  }
  function renderRadarWrap() { renderBlips(); }
  function tryEnter() {
    if (S.pin && $("#pin-input").value !== S.pin) { toast("PIN incorrecto"); return; }
    if (!S.name) {
      $("#gate").classList.add("hidden");
      $("#onboarding").classList.remove("hidden");
      return;
    }
    requestLocAndProceed();
  }

  /* ---------------- toast ---------------- */
  let toastTimer = null;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.add("hidden"), 3600);
  }

  function locStatus(msg) {
    document.querySelectorAll("#loc-status").forEach((el) => {
      el.textContent = msg;
      el.className = "loc-status pending";
      el.classList.remove("hidden");
    });
  }
  function locError(msg) {
    document.querySelectorAll("#loc-status").forEach((el) => {
      el.textContent = msg + " Pulsa Reintentar.";
      el.className = "loc-status error";
      el.classList.remove("hidden");
    });
  }
  function locOk(msg) {
    document.querySelectorAll("#loc-status").forEach((el) => {
      el.textContent = msg;
      el.className = "loc-status ok";
      el.classList.remove("hidden");
    });
  }

  /* ---- permiso de ubicación OBLIGATORIO (compartido) ---- */
  function requestLocAndProceed(name) {
    if (!name && $("#alias-input")) name = $("#alias-input").value.trim();
    const freshUser = !S.name;
    $("#alias-error").classList.add("hidden");
    locStatus("Solicitando tu ubicación (obligatoria)…");
    getLoc(
      () => {
        S.zone = nearestZone(S.lat, S.lng).name;
        updateZoneLabels();
        if (freshUser && name.length >= 2) {
          S.name = name;
          if (!S.id) newIdentity();
          else save();
        }
        save();
        locOk("Ubicación concedida ✓ Zona: " + S.zone);
        if (S.name) {
          setTimeout(() => {
            $("#onboarding").classList.add("hidden");
            enter();
          }, 400);
        }
      },
      () => locError("Ubicación NO concedida. Es obligatoria para Takuro.")
    );
  }

  /* ---------------- iniciar ---------------- */
  function init() {
    load();
    if (navigator.serviceWorker) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    makeBots();
    seedRooms();
    bindEvents();
    if (LIVE_MODE) bootLive();
    if (!S.name) {
      $("#onboarding").classList.add("hidden");
    }
  }

  /* ---------------- arranque modo en vivo ---------------- */
  async function bootLive() {
    if (!Live.connect(CONFIG.relay, {
      onJoined: (id, wallet) => {
        LIVE_MODE = true;
        if (wallet) { S.wallets = wallet; save(); renderWallets(); }
        if (!S.name) return;
        if (window.__takuro_kp) Live.setInfo(S.name, S.zone, S.radius, window.__takuro_kp.pubB64);
        syncProfileToRelay();
      },
      onWallet: (msg) => {
        S.wallets = { diario: msg.diario, kuro: msg.kuro };
        save(); renderWallets();
      },
      onDmAck: (msg) => {
        if (msg.id) delete pendingDms[msg.id];
      },
      onProfileReply: (msg) => {
        liveProfiles[msg.id] = { name: msg.name, karma: msg.karma, zone: msg.zone, wall: msg.wall || [] };
        if (sheetPeer && sheetPeer.id === msg.id && sheetPeer.live) {
          sheetPeer.name = msg.name;
          sheetPeer.karma = msg.karma;
          sheetPeer.wall = liveProfiles[msg.id].wall;
          $("#peer-name").textContent = msg.name;
          $("#peer-karma").textContent = "Karma: " + msg.karma;
          $("#peer-avatar").textContent = msg.name.charAt(0).toUpperCase();
          const zone = ZONES.find((z) => z.name === msg.zone);
          $("#peer-loc").textContent = "Zona: " + (msg.zone || S.zone) + (zone ? " (radar " + S.radius + " km)" : " · misma zona que tú");
          renderPeerWall();
        }
      },
      onFeed: (m) => {
        if (feed.some((f) => f.id === m.id)) return;
        feed.unshift({
          id: m.id, botId: null, author: m.name,
          text: m.body, ttl: m.ttl, at: m.at * 1000,
          expiresAt: m.exp ? m.exp * 1000 : 0,
          up: m.up || 0, down: m.down || 0, myVote: 0, pin: !!m.pin,
          likes: 0, liked: false, mine: m.from === Live.myId(), room: m.room,
        });
        if (m.room === S.curRoom) renderFeed();
      },
      onVote: (v) => {
        const f = feed.find((x) => x.id === v.id);
        if (!f) return;
        f.up = v.up; f.down = v.down;
        if (v.room === S.curRoom) renderFeed();
      },
      onVoteDel: (id) => {
        feed = feed.filter((x) => x.id !== id);
        renderFeed();
        toast("Un mensaje fue eliminado por la comunidad (más de 50 ▼).");
      },
      onVotePin: (id) => {
        const f = feed.find((x) => x.id === id);
        if (f) { f.pin = true; f.expiresAt = 0; }
        renderFeed();
        toast("Un mensaje fue fijado por la comunidad (más de 50 ▲).");
      },
      onPresence: (p) => {
        presence = p;
        renderBlips();
        const chip = $("#presence-chip");
        if (chip) chip.textContent = "En vivo · " + p.count + " cerca";
        if (p.count > 0) chip.classList.add("has-peers");
      },
      onDm: (msg) => {
        receiveDm(msg);
      },
      onDmOffline: (msg) => {
        if (msg.req && pendingDms[msg.req] !== undefined) {
          const chatId = pendingDms[msg.req];
          const c = S.chats[chatId];
          if (c) c.msgs = c.msgs.filter((x) => x.id !== msg.req);
          delete pendingDms[msg.req];
          save();
          if (currentPeer === chatId) renderChat();
        }
        toast("Ese usuario se desconectó. Solo puedes escribirle si sigue en línea.");
      },
      onGroupMessage: (gid, m) => {
        const g = S.groups.find((x) => x.id === gid);
        if (g) { g.msgs.push(m); save(); if (currentGroup && currentGroup.id === gid) renderGroupChat(); renderGroups(); }
      },
      onGroupCreated: (msg) => {
        if (pendingGroupForm) {
          pendingGroupForm.id = msg.id;
          pendingGroupForm.code = msg.code;
          pendingGroupForm.live = true;
          S.groups.push(pendingGroupForm);
          pendingGroupForm = null;
          save(); renderGroups(); renderWallets();
          toast("Grupo creado en el relay. Código: TK-" + msg.code);
        }
      },
      onGroupJoined: (msg) => {
        if (S.groups.some((x) => x.id === msg.id)) { renderGroups(); return; }
        S.groups.push({
          id: msg.id, name: msg.name, cond: msg.cond, radius: msg.radius,
          code: msg.code || (msg.id.replace("grp_", "") || "").slice(0, 5),
          members: msg.members, owner: msg.owner, live: true,
          msgs: (msg.msgs || []).map((m) => ({ ...m })),
        });
        save(); renderGroups();
        toast("Dentro de «" + msg.name + "».");
      },
      onError: (msg) => {
        const req = msg && msg.req;
        if (req && pendingPosts[req]) {
          feed = feed.filter((x) => x.id !== req);
          delete pendingPosts[req];
          renderFeed();
        }
        if (req && pendingDms[req] !== undefined) {
          const chatId = pendingDms[req];
          const c = S.chats[chatId];
          if (c) c.msgs = c.msgs.filter((x) => x.id !== req);
          delete pendingDms[req];
          save();
          if (currentPeer === chatId) renderChat();
        }
        const WARN = {
          sin_takus: "Takus insuficientes: no salió. Tu Sombra se recarga sola cada 24 h.",
          codigo_no_existe: "Código TK no existe en el relay.",
          post_no_existe: "Ese mensaje ya no existe aquí.",
          no_acepta: "Solo puedes ver perfiles de quien está en tu misma zona.",
          offline: "Esa persona se desconectó.",
          nombre_invalido: "Nombre de grupo inválido.",
        };
        toast(WARN[msg.why] || "Error del relay.");
        renderWallets();
      },
    })) {
      LIVE_MODE = false;
      return;
    }
    window.__takuro_kp = await Crypto.init().catch(() => null);
    if (window.__takuro_kp && S.name) Live.setInfo(S.name, S.zone, S.radius, window.__takuro_kp.pubB64);
  }

  let presence = null;
  let liveProfiles = {}; // id -> {name, karma, zone, wall}
  function livePeerAsBot(id) {
    const p = Live.peer(id);
    if (!p) return null;
    const pr = liveProfiles[id];
    return { id, name: p.name, zone: S.zone, karma: pr ? pr.karma : 120, mood: 0.5, dist: 2, r: Math.random, wall: pr ? pr.wall : null, live: true };
  }

  function syncProfileToRelay() {
    if (!LIVE_MODE || !S.name) return;
    const pub = S.wall.filter((w) => w.mode === "public").map((w) => w.img);
    Live.setProfile(pub);
  }

  function bindEvents() {
    $("#btn-open-gate").addEventListener("click", tryEnter);
    $("#btn-retry-loc").addEventListener("click", () => requestLocAndProceed());
    $("#btn-start").addEventListener("click", () => {
      const name = $("#alias-input").value.trim();
      if (name.length < 2) { $("#alias-error").classList.remove("hidden"); return; }
      $("#alias-error").classList.add("hidden");
      requestLocAndProceed(name);
    });

    document.querySelectorAll(".tab-btn").forEach((b) =>
      b.addEventListener("click", () => showView(b.dataset.view))
    );
    $("#radius-range").addEventListener("input", (e) => {
      S.radius = Number(e.target.value);
      $("#radius-value").textContent = S.radius + " km";
      save();
      if (LIVE_MODE) { Live.setInfo(S.name, S.zone, S.radius, window.__takuro_kp ? window.__takuro_kp.pubB64 : ""); }
      renderBlips(); renderFeed();
    });
    $("#btn-locate").addEventListener("click", () => {
      getLoc(() => {
        S.zone = nearestZone(S.lat, S.lng).name;
        save(); updateZoneLabels();
        if (LIVE_MODE) {
          Live.setInfo(S.name, S.zone, S.radius, window.__takuro_kp ? window.__takuro_kp.pubB64 : "");
          Live.requestPresence();
        }
        renderBlips(); renderFeed();
        toast("Ubicación real leída. Zona: " + S.zone);
      }, () => toast("No pude leer el GPS. Sigues en tu zona: " + (S.zone || "—")));
    });

    $("#btn-room-send").addEventListener("click", () => {
      const text = $("#room-input").value.trim();
      if (!text) return;
      const ttl = Number($("#room-ttl").value);
      postText(text, ttl, null, S.name, true);
      $("#room-input").value = "";
    });
    $("#room-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("#btn-room-send").click(); });
    $("#btn-room-back").addEventListener("click", closeRoom);

    // chats
    $("#chat-list").addEventListener("click", (e) => {
      const item = e.target.closest("[data-chatid]");
      if (item) openChat(item.getAttribute("data-chatid"));
    });
    $("#btn-chat-back").addEventListener("click", () => { currentPeer = null; $("#chat-view").classList.add("hidden"); renderChatList(); });
    $("#btn-send").addEventListener("click", sendText);
    $("#msg-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendText(); } });
    $("#btn-attach").addEventListener("click", () => $("#attach-input").click());
    $("#attach-input").addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { pendingImg = rd.result; toast("Imagen adjunta. Toca sellador."); };
      rd.readAsDataURL(f);
    });

    // perfil propio
    $("#pfp-input").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { S.pfp = rd.result; save(); renderMe(); };
      rd.readAsDataURL(f);
    });
    $("#wall-input").addEventListener("change", (e) => {
      const f = e.target.files[0]; if (!f) return;
      const rd = new FileReader();
      rd.onload = () => { S.wall.push({ id: uid(), img: rd.result, mode: "hidden", once: false }); save(); renderMe(); syncProfileToRelay(); toast("Subida al muro (oculta). Tócala para ponerla pública."); };
      rd.readAsDataURL(f);
    });
    $("#btn-add-demo-pic").addEventListener("click", () => {
      S.wall.push({ id: uid(), img: demoTile(), mode: "hidden", once: false });
      save(); renderMe(); syncProfileToRelay();
    });
    $("#opt-quiet").addEventListener("change", (e) => { S.quiet = e.target.checked; save(); });
    $("#opt-pin").addEventListener("change", (e) => {
      if (e.target.checked) {
        const pin = prompt("Elige un PIN de 4-6 dígitos para despertar Takuro:");
        if (pin && /^[0-9]{4,6}$/.test(pin)) { S.pin = pin; } else { e.target.checked = false; toast("PIN no válido."); }
      } else { S.pin = ""; }
      save();
    });
    $("#btn-wipe").addEventListener("click", () => {
      if (confirm("¿Quemar todo en este dispositivo? Se borrará tu identidad.")) {
        try { localStorage.removeItem(LS_KEY); } catch (e) {}
        location.reload();
      }
    });

    // hoja de perfil
    $("#btn-sheet-close").addEventListener("click", () => $("#profile-sheet").classList.add("hidden"));
    $("#btn-peer-chat").addEventListener("click", () => {
      const id = sheetPeer.id;
      $("#profile-sheet").classList.add("hidden");
      openChat(id);
    });
    $("#btn-peer-block").addEventListener("click", blockPeer);

    // sello
    const brk = $("#btn-break");
    let holdTimer = null;
    brk.addEventListener("pointerdown", () => {
      holdTimer = setTimeout(breakSeal, 900);
    });
    brk.addEventListener("pointerup", () => clearTimeout(holdTimer));
    brk.addEventListener("pointerleave", () => clearTimeout(holdTimer));
    $("#btn-once-close").addEventListener("click", () => $("#once-box").classList.add("hidden"));

    // takus
    $("#btn-refresh-daily").addEventListener("click", doDailyRefill);

    // grupos
    $("#btn-open-group-form").addEventListener("click", () => $("#group-form").classList.remove("hidden"));
    $("#btn-close-group-form").addEventListener("click", () => $("#group-form").classList.add("hidden"));
    $("#grp-radius-row").classList.toggle("hidden", $("#grp-cond").value !== "rango");
    $("#grp-cond").addEventListener("change", (e) => {
      $("#grp-radius-row").classList.toggle("hidden", e.target.value !== "rango");
    });
    $("#btn-create-group").addEventListener("click", createGroup);
    $("#btn-join-code").addEventListener("click", joinByCode);
    $("#grp-code-input").addEventListener("keydown", (e) => { if (e.key === "Enter") joinByCode(); });
    $("#btn-group-back").addEventListener("click", () => { currentGroup = null; $("#group-view").classList.add("hidden"); renderGroups(); });
    $("#btn-group-send").addEventListener("click", sendGroup);
    $("#group-input").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendGroup(); } });

    // membresía (perímetro extendido)
    $("#opt-premium").addEventListener("change", (e) => {
      S.premium = e.target.checked;
      if (S.radius > radioMax()) S.radius = radioMax();
      save();
      renderPerimetro();
      renderFeed(); renderBlips();
      toast(S.premium ? "Discreta+ activa: perímetro hasta 50 km." : "Modo normal: perímetro hasta 20 km.");
    });

    // ticks
    setInterval(tick, 1000);
    setInterval(botPostTick, 9000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();