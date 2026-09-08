/* Takuro v2 — cliente WebSocket del relay en vivo. */

const Live = (() => {
  let ws = null;
  let ok = false;
  let myId = null;
  const peers = new Map(); // id -> {name, pub, zone}
  const groups = new Map(); // id -> {name, members}
  const hooks = {
    onFeed: null, onPresence: null, onDm: null, onDmOffline: null,
    onGroupMessage: null, onGroupCreated: null, onGroupJoined: null,
    onJoined: null, onError: null,
    onVote: null, onVoteDel: null, onVotePin: null,
    onWallet: null, onDmAck: null, onProfileReply: null,
  };

  function connect(url, h) {
    Object.assign(hooks, h || {});
    try {
      ws = new WebSocket(url);
    } catch (e) { return false; }
    ws.onopen = () => { ok = true; };
    ws.onclose = () => { ok = false; };
    ws.onerror = () => { ok = false; };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      route(msg);
    };
    return true;
  }

  function send(msg) {
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  function route(msg) {
    const t = msg.t;
    if (t === "hello") {
      myId = msg.id;
      if (hooks.onJoined) hooks.onJoined(myId);
    } else if (t === "joined") {
      if (hooks.onJoined) hooks.onJoined(myId, msg.wallet || null);
    } else if (t === "wallet") {
      if (hooks.onWallet) hooks.onWallet(msg);
    } else if (t === "dm_ack") {
      if (hooks.onDmAck) hooks.onDmAck(msg);
    } else if (t === "profile_reply") {
      if (hooks.onProfileReply) hooks.onProfileReply(msg);
    } else if (t === "feed") {
      if (hooks.onFeed) hooks.onFeed(msg.m);
    } else if (t === "presence") {
      peers.clear();
      (msg.who || []).forEach((w) => peers.set(w.id, { name: w.name, pub: w.pub, zone: msg.zone }));
      const me = peers.get(myId);
      if (me) me.isMe = true;
      if (hooks.onPresence) hooks.onPresence(msg);
    } else if (t === "dm") {
      if (hooks.onDm) hooks.onDm(msg);
    } else if (t === "dm_offline") {
      if (hooks.onDmOffline) hooks.onDmOffline(msg);
    } else if (t === "grp_msg") {
      if (hooks.onGroupMessage) hooks.onGroupMessage(msg.gid, msg.m);
    } else if (t === "grp_created") {
      if (hooks.onGroupCreated) hooks.onGroupCreated(msg);
    } else if (t === "grp_joined") {
      if (hooks.onGroupJoined) hooks.onGroupJoined(msg);
    } else if (t === "vote") {
      if (hooks.onVote) hooks.onVote(msg);
    } else if (t === "vote_del") {
      if (hooks.onVoteDel) hooks.onVoteDel(msg.id);
    } else if (t === "vote_pin") {
      if (hooks.onVotePin) hooks.onVotePin(msg.id);
    } else if (t === "err") {
      if (hooks.onError) hooks.onError(msg);
    }
  }

  return {
    connect, send, ok: () => ok,
    myId: () => myId,
    peer: (id) => peers.get(id) || null,
    peers: () => Array.from(peers.values()).filter((p) => !p.isMe),
    setInfo: (name, zone, radius, pub) => send({ t: "join", name, zone, radius, pub }),
    sub: (room) => send({ t: "sub", room }),
    unsub: (room) => send({ t: "unsub", room }),
    post: (room, body, ttl, cr) => send({ t: "post", room, body, ttl, cr }),
    vote: (id, v, cr) => send({ t: "vote", id, v, cr }),
    refreshWallet: () => send({ t: "wallet_now" }),
    profile: (id, cr) => send({ t: "profile", id, cr }),
    setProfile: (wall) => send({ t: "set_profile", wall }),
    dm: (to, packet, clientId) => send({ t: "dm_send", to, ...packet, client_id: clientId }),
    requestPresence: () => send({ t: "list_presence" }),
    createGroup: (name, cond, radius) => send({ t: "grp_create", name, cond, radius }),
    joinGroup: (code) => send({ t: "grp_join", code }),
    groupMsg: (gid, text, ttl) => send({ t: "grp_msg", id: gid, text, ttl }),
  };
})();