// Package the static board as a restricted-wasm-v1 Tauri frontend (KOTOBA-159).
// The board works fully offline, so the guest is one self-contained document:
// the public style and body plus the app script (with a memory storage shim,
// since the opaque-origin sandbox has no localStorage). No network, no parent
// DOM, no persistence across launches. The host page verifies the guest
// against the digest pinned here and mounts it in a sandboxed iframe.
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";
import { clientRuntimeConnectSrc, clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";

const here = fileURLToPath(new URL("../", import.meta.url));
const repo = path.resolve(here, "..");
const source = path.resolve(process.env.STATIC_SRC ?? path.join(here, "../public"));
const out = path.resolve(process.env.TAURI_DIST ?? path.join(here, "dist"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const shaB64 = (text) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
const fail = (message) => { console.error(`tauri build: ${message}`); process.exit(1); };

const pins = JSON.parse(await readFile(path.join(here, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(path.join(here, "vendor", name))) !== digest) fail(`canonical runtime pin drift: ${name}`);
}

const capabilities = requestedCapabilities(descriptor);
const origins = ["https://tauri.localhost"];
const problems = clientRuntimeProblems(descriptor, capabilities, origins);
if (problems.length) fail(`descriptor is invalid: ${JSON.stringify(problems)}`);
if (descriptor.profile !== "restricted-wasm-v1") fail(`profile is ${descriptor.profile}; this build only ships restricted-wasm-v1`);
const connect = clientRuntimeConnectSrc(descriptor, capabilities, [], origins);
if (connect !== "connect-src 'none'") fail(`connect-src must be 'none' for an operation-free app: ${connect}`);

const index = await readFile(path.join(source, "index.html"), "utf8").catch(() => null);
if (index === null) fail(`${path.join(source, "index.html")} is missing`);
const title = (...args) => {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(index);
  if (!m) fail("public/index.html has no <title>");
  return m[1];
};
const styles = [...index.matchAll(/<style>([\s\S]*?)<\/style>/gi)];
if (styles.length !== 1) fail(`public/index.html must hold exactly one inline <style>: found ${styles.length}`);
const style = styles[0][1];
if (/<\/style/i.test(style)) fail("guest style contains </style");
if (/url\(\s*["']?https?:/i.test(style)) fail("guest style references a remote URL");
let body = (m => {
  if (!m) fail("public/index.html has no <body>");
  if (/<script[\s>]/i.test(m[1])) fail("guest body must not carry a script; app.js is inlined by this build");
  if (/<iframe[\s>]/i.test(m[1])) fail("guest body must not carry an iframe (frame-src 'none')");
  return m[1];
})(/<body[^>]*>([\s\S]*?)<\/body>/i.exec(index));
// form-action 'none' stops dialog-method submission, so the post button must
// not be a submit button (see submit-wiring.js). Exactly one replacement.
{
  const before = body;
  body = body.replace(/(<button\b[^>]*\bid="post-submit"[^>]*)\btype="submit"/, '$1type="button"');
  if (body === before) fail('guest body has no type="submit" #post-submit to rewrite');
  if (/id="post-submit"[^>]*type="submit"/.test(body)) fail("guest body still carries a submit button");
}
const scripts = [...index.matchAll(/<script\b[^>]*>/gi)];
if (scripts.length !== 1 || !/src=["']js\/app\.js["']/.test(scripts[0][0])) {
  fail("public/index.html must load exactly one script: js/app.js");
}

const app = await readFile(path.join(source, "js/app.js"), "utf8").catch(() => null);
if (app === null) fail(`${path.join(source, "js/app.js")} is missing`);
const shim = await readFile(path.join(here, "src/storage-shim.js"), "utf8");
// The sandbox CSP carries form-action 'none', which stops the dialog-method
// submission the post form used (requestSubmit and the submit button go
// through the blocked submission algorithm, so no submit event fires). The
// button below is rewritten to type="button" and this wiring replays the
// submit to the app's own handler; the app validates the fields itself.
const wiring = await readFile(path.join(here, "src/submit-wiring.js"), "utf8");
const guestScript = `${shim}\n${app}\n${wiring}`;
if (/<\/script/i.test(guestScript)) fail("guest script contains </script");
if (/^\s*import\b/m.test(guestScript) || /^\s*export\b/m.test(guestScript)) {
  fail("the restricted guest script must not import or export");
}

const fill = (template, what, values) => template.replace(/\{\{([A-Z]+)\}\}/g, (_, key) => {
  if (!Object.hasOwn(values, key)) fail(`${what} has an unfilled placeholder {{${key}}}`);
  return values[key];
});
const vendorText = await readFile(path.join(here, "vendor/kotoba-client-runtime.js"), "utf8");
const preambleText = (() => {
  const m = /^const GUEST_PREAMBLE = '<script>([^'\\]*)<\/script>';$/m.exec(vendorText);
  if (!m) fail("vendor/kotoba-client-runtime.js has no GUEST_PREAMBLE this build can hash");
  return m[1];
})();

const commit = (() => {
  try {
    return execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    fail("restricted-wasm-v1 pins the guest to its source commit: build from a git checkout");
  }
})();
if (!/^[0-9a-f]{40}$/.test(commit)) fail(`git rev-parse HEAD gave ${JSON.stringify(commit)}`);

const guest = fill(await readFile(path.join(here, "src/guest.html"), "utf8"), "guest.html", {
  TITLE: title(), STYLE: style, BODY: body, SCRIPT: guestScript,
});
const guestBytes = Buffer.from(guest, "utf8");
if (guestBytes.length > 8 * 1024 * 1024) fail("the restricted guest exceeds the 8 MiB mount budget");
const artifact = { revision: commit, sha256: sha(guestBytes), "max-bytes": guestBytes.length };

const csp = [
  "default-src 'none'",
  `script-src 'self' ${shaB64(preambleText)} ${shaB64(guestScript)}`,
  `style-src 'self' ${shaB64(style)}`,
  "img-src 'self' data:",
  "font-src 'self'",
  connect,
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

const confPath = path.join(here, "src-tauri/tauri.conf.json");
const conf = JSON.parse(await readFile(confPath, "utf8"));
if (conf.app?.security?.csp !== csp) {
  if (process.env.WRITE_CSP === "1") {
    conf.app.security.csp = csp;
    await writeFile(confPath, JSON.stringify(conf, null, 2) + "\n");
    console.error("tauri build: wrote src-tauri/tauri.conf.json csp; re-run to verify");
    process.exit(2);
  }
  fail("src-tauri/tauri.conf.json csp differs from the derived policy; re-run with WRITE_CSP=1");
}

await rm(out, { recursive: true, force: true });
await mkdir(path.join(out, "vendor"), { recursive: true });
await writeFile(path.join(out, "index.html"),
  fill(await readFile(path.join(here, "src/host.html"), "utf8"), "host.html", { CSP: csp, TITLE: title() }));
await cp(path.join(here, "src/host.js"), path.join(out, "host.js"));
await cp(path.join(here, "src/host.css"), path.join(out, "host.css"));
await cp(path.join(here, "vendor/kotoba-client-runtime.js"), path.join(out, "vendor/kotoba-client-runtime.js"));
await cp(path.join(here, "vendor/kotoba-client-consent.css"), path.join(out, "vendor/kotoba-client-consent.css"));
await writeFile(path.join(out, "host-data.js"),
  `export default ${JSON.stringify({ descriptor, artifact, guest })};\n`);
await writeFile(path.join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");

const files = {};
const walk = async (dir) => {
  for (const entry of await readdir(path.join(out, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await walk(rel);
    else files[rel] = sha(await readFile(path.join(out, rel)));
  }
};
await walk("");
delete files["release.json"];
await writeFile(path.join(out, "release.json"), JSON.stringify({
  schema: "awai.app.artifact.v1", id: "cloud.itonami.classifieds", tauri: "3.0.0-alpha.6",
  profile: descriptor.profile, runtimePins: pins, files, guest: artifact,
}, null, 2) + "\n");
console.log(`Classifieds restricted frontend: ${Object.keys(files).length} files; ${connect}; guest ${guestBytes.length} bytes`);
