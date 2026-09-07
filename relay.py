"""
TAKURO relay v2 — servidor efímero de la demo en vivo.

Python puro, sin dependencias. MODOS:
  1. Local:  python relay.py [puerto]
     sirve public/ por HTTP + WebSocket en el mismo puerto (/ws).
  2. Render: corre igual (ver render.yaml). Solo WS en :$(PORT);
     el front va en Vercel y apunta a este relay por WebSocket.

Lo que el relay sabe (mínimo):
  - Zona y sala: para enrutar el "murmullo" público (es público por diseño).
  - Quién está presente (online ahora) en tu zona.
  - LOS MENSAJES PRIVADOS SON OPACOS: solo reenvía el paquete cifrado.
  - NADA se guarda: todo vive en memoria y expira con su TTL.
  - No almacena identidades persistentes ni contactos.

E2E real: lo hace el navegador con WebCrypto (ECDH P-256 + AES-GCM).
"""

import asyncio
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "public")
HTTP_PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("PORT", 8080))
WS_ONLY = os.environ.get("WS_ONLY", "0") == "1" or os.environ.get("RENDER") == "true" or "RENDER_INSTANCE_ID" in os.environ

SALAS = ["chisme", "ligar", "plaza"]

# ---------------- WebSocket (RFC 6455) mínimo ----------------

def ws_accept(key: bytes) -> str:
    return base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest()).decode()

class WS:
    def __init__(self, reader, writer):
        self.r = reader
        self.w = writer
        self.name = ""

    @classmethod
    async def handshake(cls, reader, writer, headers):
        key = None
        for h in headers:
            if h[0].lower() == "sec-websocket-key":
                key = h[1].strip().encode()
        if not key:
            return None
        writer.write(
            b"HTTP/1.1 101 Switching Protocols\r\n"
            b"Upgrade: websocket\r\n"
            b"Connection: Upgrade\r\n"
            b"Sec-WebSocket-Accept: " + ws_accept(key).encode() + b"\r\n\r\n"
        )
        await writer.drain()
        return cls(reader, writer)

    async def recv(self):
        try:
            hdr = await self.r.readexactly(2)
        except Exception:
            return None
        b1, b2 = hdr[0], hdr[1]
        opcode = b1 & 0x0F
        length = b2 & 0x7F
        if length == 126:
            try:
                length = struct.unpack(">H", await self.r.readexactly(2))[0]
            except Exception:
                return None
        elif length == 127:
            try:
                length = struct.unpack(">Q", await self.r.readexactly(8))[0]
            except Exception:
                return None
        mask = await self.r.readexactly(4) if b2 & 0x80 else None
        try:
            data = await self.r.readexactly(length) if length else b""
        except Exception:
            return None
        if mask:
            data = bytes(c ^ mask[i % 4] for i, c in enumerate(data))
        if opcode == 8:
            return None
        if opcode == 9:
            await self.send(data, 0xA)
            return await self.recv()
        try:
            msg = json.loads(data.decode("utf-8"))
            return msg
        except Exception:
            return None

    async def send(self, obj, opcode=0x1):
        data = obj if isinstance(obj, bytes) else json.dumps(obj, ensure_ascii=False).encode("utf-8")
        header = bytearray([0x80 | opcode])
        length = len(data)
        if length < 126:
            header.append(length)
        elif length < 65536:
            header.append(126)
            header.extend(struct.pack(">H", length))
        else:
            header.append(127)
            header.extend(struct.pack(">Q", length))
        self.w.write(bytes(header) + data)
        await self.w.drain()

# ---------------- Estado en memoria ----------------

STATE = {
    "peers": {},          # id -> {ws, name, zone, radius, pub, rooms:[], since}
    "feeds": {},          # [room][zone] -> [msg]
    "groups": {},         # code -> {id, name, cond, radius, owner, members:[peerid], msgs:[]}
    "code_of": {},        # group.id -> code
}

def now():
    return time.time()

def m_id():
    return os.urandom(6).hex()

# Votación de salas (reglas YikYak): >50 negativos -> se elimina; >50 positivos -> se fija siempre
UP_PIN = 50
DOWN_DEL = 50

def public_m(m):
    """Versión 'pública' de un mensaje de sala: solo conteos, nunca quién votó."""
    return {
        "id": m["id"], "from": m["from"], "name": m["name"], "body": m["body"],
        "room": m["room"], "zone": m["zone"], "ttl": m["ttl"], "at": m["at"],
        "exp": m.get("exp", m["at"] + m["ttl"]),
        "up": len(m.get("up", [])), "down": len(m.get("down", [])),
        "pin": bool(m.get("pin")),
    }

async def send(ws, obj):
    try:
        await ws.send(obj)
    except Exception:
        pass

# ---------------- Purga de TTL ----------------

async def purge():
    while True:
        await asyncio.sleep(10)
        cut = now()
        for room in list(STATE["feeds"]):
            for zone in list(STATE["feeds"][room]):
                keep = [m for m in STATE["feeds"][room][zone] if not m.get("exp") or m["exp"] > cut]
                if keep:
                    STATE["feeds"][room][zone] = keep
                else:
                    STATE["feeds"][room].pop(zone, None)
        for g in STATE["groups"].values():
            g["msgs"] = [m for m in g["msgs"] if not m.get("exp") or m["exp"] > cut]

# ---------------- Enrutado ----------------

async def route(pid, msg):
    p = STATE["peers"].get(pid)
    if not p:
        return
    ws = p["ws"]
    t = msg.get("t")

    if t == "join":
        p["name"] = msg.get("name", "Anónimo")
        p["zone"] = msg.get("zone")
        p["radius"] = msg.get("radius", 15)
        p["pub"] = msg.get("pub")          # clave ECDH pública (opaca para el relay)
        await send(ws, {"t": "joined", "id": pid})
        await broadcast_presence(p["zone"])

    elif t == "sub":
        p["rooms"] = list(set((p.get("rooms") or []) + [msg.get("room")]))
        room, zone = msg.get("room"), p["zone"]
        for m in STATE["feeds"].get(room, {}).get(zone, []):
            if not m.get("exp") or m["exp"] > now():
                await send(ws, {"t": "feed", "m": public_m(m)})

    elif t == "unsub":
        p["rooms"] = [r for r in (p.get("rooms") or []) if r != msg.get("room")]

    elif t == "post":
        room = msg.get("room")
        if room not in SALAS:
            return
        m = {
            "id": m_id(), "from": pid,
            "name": p["name"], "body": msg.get("body", ""),
            "room": room, "zone": p["zone"],
            "ttl": min(int(msg.get("ttl") or 300), 86400),
            "at": now(),
            "exp": now() + min(int(msg.get("ttl") or 300), 86400),
            "up": [], "down": [], "pin": False,
        }
        STATE["feeds"].setdefault(room, {}).setdefault(p["zone"], []).insert(0, m)
        for pid2, p2 in STATE["peers"].items():
            if p2["zone"] == p["zone"] and room in (p2.get("rooms") or []):
                await send(p2["ws"], {"t": "feed", "m": public_m(m)})

    elif t == "vote":
        mid = msg.get("id")
        v = 1 if msg.get("v") == 1 else -1
        target = None
        for room, zones in STATE["feeds"].items():
            for zone, msgs in zones.items():
                if zone != p["zone"]:
                    continue
                for m in msgs:
                    if m["id"] == mid:
                        target = (room, zone, m)
                        break
                if target:
                    break
            if target:
                break
        if not target:
            await send(ws, {"t": "err", "why": "post_no_existe"})
            return
        room, zone, m = target
        up = m.setdefault("up", [])
        down = m.setdefault("down", [])
        if pid in up:
            up.remove(pid)
        if pid in down:
            down.remove(pid)
        if v == 1:
            up.append(pid)
        else:
            down.append(pid)
        for pid2, p2 in STATE["peers"].items():
            if p2["zone"] == zone and room in (p2.get("rooms") or []):
                await send(p2["ws"], {"t": "vote", "id": mid, "room": room, "zone": zone,
                                      "up": len(up), "down": len(down)})
        if len(down) > DOWN_DEL:
            STATE["feeds"][room][zone] = [x for x in STATE["feeds"][room][zone] if x["id"] != mid]
            for pid2, p2 in STATE["peers"].items():
                if p2["zone"] == zone and room in (p2.get("rooms") or []):
                    await send(p2["ws"], {"t": "vote_del", "id": mid})
        elif len(up) > UP_PIN and not m.get("pin"):
            m["pin"] = True
            m["exp"] = 0  # se fija para siempre (exento de la purga TTL)
            for pid2, p2 in STATE["peers"].items():
                if p2["zone"] == zone and room in (p2.get("rooms") or []):
                    await send(p2["ws"], {"t": "vote_pin", "id": mid})

    elif t == "list_presence":
        await presence_msg(ws, p["zone"])

    elif t == "dm_send":
        to = msg.get("to")
        p2 = STATE["peers"].get(to)
        if not p2:
            await send(ws, {"t": "dm_offline", "to": to})
            return
        await send(p2["ws"], {"t": "dm", "m": {
            "id": m_id(), "from": pid, "from_name": p["name"],
            "ct": msg.get("ct"), "iv": msg.get("iv"),
            "at": now(),
        }})
        await send(ws, {"t": "dm_ack", "id": msg.get("client_id"), "to": to})

    elif t == "grp_create":
        name = (msg.get("name") or "").strip()[:30]
        if len(name) < 2:
            await send(ws, {"t": "err", "why": "nombre_invalido"})
            return
        gid = "grp_" + m_id()
        j = 0
        code = grp_code()
        while code in STATE["groups"]:
            code = grp_code()
        g = {"id": gid, "name": name, "cond": msg.get("cond", "rango"),
             "radius": int(msg.get("radius") or 10), "owner": pid,
             "members": [pid], "msgs": []}
        STATE["groups"][code] = g
        STATE["code_of"][gid] = code
        p["groups"] = (p.get("groups") or []) + [gid]
        await send(ws, {"t": "grp_created", "id": gid, "code": code})

    elif t == "grp_join":
        code = (msg.get("code") or "").upper().replace("TK-", "")
        g = STATE["groups"].get(code)
        if g is None:
            await send(ws, {"t": "err", "why": "codigo_no_existe"})
            return
        if pid not in g["members"]:
            g["members"].append(pid)
        p["groups"] = (p.get("groups") or []) + [g["id"]]
        await send(ws, {"t": "grp_joined", "id": g["id"], "name": g["name"], "cond": g["cond"], "radius": g["radius"], "owner": g["owner"], "members": [g["owner"]] + g["members"][1:], "msgs": [m for m in g["msgs"]], "code": code})

    elif t == "grp_msg":
        for g in STATE["groups"].values():
            if g["id"] == msg.get("id") and pid in g["members"]:
                mm = {
                    "id": m_id(), "from": pid, "name": p["name"],
                    "text": msg.get("text", ""), "at": now(),
                    "ttl": int(msg.get("ttl") or 0),
                    "exp": now() + int(msg.get("ttl") or 0) if msg.get("ttl") else 0,
                }
                g["msgs"].append(mm)
                for m2 in g["members"]:
                    pp = STATE["peers"].get(m2)
                    if pp:
                        await send(pp["ws"], {"t": "grp_msg", "gid": g["id"], "m": mm})
                break

def grp_code():
    chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(chars[random_bits() % len(chars)] for _ in range(5))

def random_bits():
    return int.from_bytes(os.urandom(2), "big")

async def presence_msg(ws, zone):
    who = [{"id": pid, "name": rec["name"], "pub": rec.get("pub")}
           for pid, rec in STATE["peers"].items() if rec["zone"] == zone]
    await send(ws, {"t": "presence", "zone": zone, "count": len(who), "who": who})

async def broadcast_presence(zone):
    items = [(pid, rec) for pid, rec in STATE["peers"].items() if rec["zone"] == zone]
    payload = {"t": "presence", "zone": zone, "count": len(items),
               "who": [{"id": pid, "name": rec["name"], "pub": rec.get("pub")} for pid, rec in items]}
    for _pid, rec in items:
        await send(rec["ws"], payload)

# ---------------- Manejo de conexión ----------------

async def handle_peer(ws):
    peer_id = "p_" + os.urandom(8).hex()
    STATE["peers"][peer_id] = {"ws": ws, "name": "Anónimo", "zone": None, "radius": 15, "pub": None, "rooms": [], "groups": [], "since": now()}
    await send(ws, {"t": "hello", "id": peer_id})
    try:
        while True:
            msg = await ws.recv()
            if msg is None:
                break
            if msg.get("t"):
                try:
                    await route(peer_id, msg)
                except Exception as exc:
                    import traceback
                    print("ERR relay:", repr(exc))
                    traceback.print_exc()
    finally:
        old_zone = STATE["peers"][peer_id]["zone"]
        STATE["peers"].pop(peer_id, None)
        try:
            await ws.w.close()
        except Exception:
            pass
        if old_zone:
            await broadcast_presence(old_zone)

# ---------------- HTTP estático (modo local) ----------------

class Quiet(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        SimpleHTTPRequestHandler.end_headers(self)

async def ws_bridge(reader, writer):
    try:
        req = await reader.readline()
        if not req:
            writer.close()
            return
        headers = []
        while True:
            line = await reader.readline()
            if line in (b"\r\n", b"\n", b""):
                break
            if b":" in line:
                k, v = line.split(b":", 1)
                headers.append((k.decode(errors="ignore").strip(), v.decode(errors="ignore").strip()))
        upgraded = any(h[0].lower() == "upgrade" and h[1].lower() == "websocket" for h in headers)
        if upgraded:
            ws = await WS.handshake(reader, writer, headers)
            if ws:
                await handle_peer(ws)
            return
        writer.write(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        writer.close()
    except Exception:
        try:
            writer.close()
        except Exception:
            pass

# ---------------- arranque ----------------

def lan_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"
    finally:
        s.close()

def main():
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    if WS_ONLY:
        server = loop.run_until_complete(asyncio.start_server(ws_bridge, "0.0.0.0", HTTP_PORT))
        loop.create_task(purge())
        ip = "0.0.0.0"
        print("TAKURO relay v2 · WS-only en puerto %d (Render)" % HTTP_PORT)
    else:
        WS_PORT = int(sys.argv[2]) if len(sys.argv) > 2 else HTTP_PORT + 1
        server = loop.run_until_complete(asyncio.start_server(ws_bridge, "0.0.0.0", WS_PORT))
        httpd = ThreadingHTTPServer(("0.0.0.0", HTTP_PORT), Quiet)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        loop.create_task(purge())
        ip = lan_ip()
        print("=" * 46)
        print("TAKURO relay v2 (local)")
        print("  Web (esta PC): http://localhost:%d" % HTTP_PORT)
        print("  Web (móvil)  : http://%s:%d  (misma red WiFi)" % (ip, HTTP_PORT))
        print("  WebSocket    : ws://%s:%d/ws" % (ip, WS_PORT))
    print("  NADA se guarda. Privados = paquetes opacos (E2E en el cliente).")
    print("=" * 46)
    try:
        loop.run_forever()
    except KeyboardInterrupt:
        print("\nrelay cerrado.")

if __name__ == "__main__":
    main()