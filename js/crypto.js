/* Takuro v2 — Cifrado E2E con WebCrypto (sin dependencias).
   ECDH P-256 + AES-256-GCM. Las llaves viven SOLO en este dispositivo.
   El relay solo ve paquetes opacos {ct, iv, from_pub}. */

const Crypto = (() => {
  const LS = "takuro_v2_keys";

  async function init() {
    let kp = null;
    try {
      const raw = JSON.parse(localStorage.getItem(LS));
      if (raw && raw.private && raw.public) {
        kp = {
          privateKey: await crypto.subtle.importKey("jwk", raw.private, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]),
          publicKey: await crypto.subtle.importKey("jwk", raw.public, { name: "ECDH", namedCurve: "P-256" }, false, []),
        };
      }
    } catch (e) { kp = null; }
    if (!kp) {
      kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
      const priv = await crypto.subtle.exportKey("jwk", kp.privateKey);
      const pub = await crypto.subtle.exportKey("jwk", kp.publicKey);
      localStorage.setItem(LS, JSON.stringify({ private: priv, public: pub }));
    }
    kp.pubRaw = await exportRaw(kp.publicKey);
    kp.pubB64 = b64(kp.pubRaw);
    return kp;
  }

  function b64(ab) {
    const b = new Uint8Array(ab);
    let s = "";
    b.forEach((x) => (s += String.fromCharCode(x)));
    return btoa(s);
  }
  function fromB64(s) {
    const bin = atob(s);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
    return u;
  }
  async function exportRaw(pubKey) {
    return await crypto.subtle.exportKey("raw", pubKey);
  }
  async function importRaw(pubB64) {
    return await crypto.subtle.importKey("raw", fromB64(pubB64), { name: "ECDH", namedCurve: "P-256" }, false, []);
  }

  const shared = new Map(); // pubB64 -> CryptoKey AES-GCM

  async function sharedKey(myPrivate, peerPubB64) {
    if (shared.has(peerPubB64)) return shared.get(peerPubB64);
    try {
      const peer = await importRaw(peerPubB64);
      const bits = await crypto.subtle.deriveBits({ name: "ECDH", public: peer }, myPrivate, 256);
      const hkdf = await crypto.subtle.importKey("raw", bits, "HKDF", false, ["deriveKey"]);
      const key = await crypto.subtle.deriveKey(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(16), info: new TextEncoder().encode("takuro-dm-v2") },
        hkdf, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]
      );
      shared.set(peerPubB64, key);
      return key;
    } catch (e) {
      return null;
    }
  }

  async function seal(kp, peerPubB64, text) {
    const key = await sharedKey(kp.privateKey, peerPubB64);
    if (!key) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(text));
    return { iv: b64(iv.buffer), ct: b64(ct) };
  }

  async function open(kp, peerPubB64, packet) {
    const key = await sharedKey(kp.privateKey, peerPubB64);
    if (!key || !packet) return null;
    try {
      const out = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: fromB64(packet.iv) },
        key, fromB64(packet.ct).buffer
      );
      return new TextDecoder().decode(out);
    } catch (e) {
      return null;
    }
  }

  return { init, seal, open, pubB64: () => (window.__takuro_kp && window.__takuro_kp.pubB64) || "" };
})();