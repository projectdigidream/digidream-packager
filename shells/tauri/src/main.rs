// The Tauri runner: a game in the operating system's own web view.
//
// One program per OS, built once per engine version into a packager kit, that
// runs whatever game the packager lays beside it:
//
//   game/game.json       { name, id, module, map }
//   game/web/            the client (served to the web view), exactly the tree
//                        the Android APK serves -- shell.js included
//   game/game/           what the server reads: assets/props.txt, modules/<id>/
//   game/bin/dnp-server  the authoritative server for this OS
//
// (on macOS under Contents/Resources/, beside the executable elsewhere).
//
// It does what the Android and iOS shells do, in Rust: serves game/web from a
// custom scheme (a SECURE context, which the client's wasm and AudioWorklet
// need), starts the server on a free loopback port, and relays raw link bytes
// between that socket and the page. The page side is the engine's shared
// shell.js over `window.dnpNative` (up / close / log), which the packager
// prepends a three-line shim for (shells/tauri/web/tauri-native.js). Nothing
// here parses the game protocol: link frames are framing.js's business, in
// JavaScript, as in every other shell.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine as _;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};
use tauri::http::{Response, StatusCode};
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

struct Link {
    stream: Mutex<Option<TcpStream>>,
    pending: Mutex<Vec<Vec<u8>>>, // bytes the page sent before the socket was up
    server: Mutex<Option<Child>>,
}

fn game_dir() -> PathBuf {
    let exe = std::env::current_exe().expect("current_exe");
    let dir = exe.parent().expect("exe dir").to_path_buf();
    let mac = dir.join("..").join("Resources").join("game");
    if mac.join("game.json").exists() {
        return mac;
    }
    dir.join("game")
}

fn mime(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("");
    match ext {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json",
        "wasm" => "application/wasm",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "svg" => "image/svg+xml",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// game/web/<path>, refusing anything that climbs out of it.
fn serve(web: &Path, raw_path: &str) -> Response<Vec<u8>> {
    let decoded = percent_decode(raw_path);
    let mut path = decoded.trim_start_matches('/').to_string();
    if path.is_empty() {
        path = "index.html".into();
    }
    if path.split('/').any(|s| s == "..") {
        return Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap();
    }
    match std::fs::read(web.join(&path)) {
        Ok(body) => Response::builder()
            .header("Content-Type", mime(&path))
            .header("Cache-Control", "no-store")
            .body(body)
            .unwrap(),
        Err(_) => Response::builder().status(StatusCode::NOT_FOUND).body(Vec::new()).unwrap(),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Ok(v) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0").and_then(|l| l.local_addr()).map(|a| a.port()).unwrap_or(34500)
}

// Where the server writes -- save games, level state, the graphs' saved
// variables (engine docs/GRAPHS.md "Saved on disk"): the user's own data
// directory, per game. Its default, .dnp-state in its cwd, is inside the app,
// which is read-only (and on macOS, sealed). The server starts before Tauri
// does, so this is worked out from the environment rather than asked of it.
fn state_dir(id: &str) -> Option<std::path::PathBuf> {
    let home = std::env::var_os("HOME").map(std::path::PathBuf::from);
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(std::path::PathBuf::from)
    } else if cfg!(target_os = "macos") {
        home.map(|h| h.join("Library").join("Application Support"))
    } else {
        std::env::var_os("XDG_DATA_HOME").map(std::path::PathBuf::from).or_else(|| home.map(|h| h.join(".local").join("share")))
    }?;
    Some(base.join(id).join("state"))
}

fn start_server(game: &Path, conf: &serde_json::Value, port: u16) -> std::io::Result<Child> {
    let exe = if cfg!(windows) { "dnp-server.exe" } else { "dnp-server" };
    let bin = game.join("bin").join(exe);
    let id = conf["id"].as_str().unwrap_or("game");
    let tree = game.join("game");
    let module = tree.join("modules").join(id);
    let mut cmd = Command::new(&bin);
    cmd.arg("--port").arg(port.to_string()).arg("--module").arg(&module);
    // The whole module: the chosen map first (where players start), then every
    // other .dnpm, in name order. Given only the first, the server hosts only
    // that one, and a graph going to another map (change_map) is refused --
    // the game dies starting.
    if let Some(map) = conf["map"].as_str() {
        cmd.arg("--map").arg(module.join("maps").join(map));
        let mut others: Vec<std::path::PathBuf> = std::fs::read_dir(module.join("maps"))
            .map(|rd| rd.filter_map(|e| e.ok()).map(|e| e.path())
                .filter(|p| p.extension().map_or(false, |x| x == "dnpm")
                    && p.file_name().map_or(false, |n| n != map))
                .collect())
            .unwrap_or_default();
        others.sort();
        for p in others.into_iter().take(63) { cmd.arg("--map").arg(p); }
        cmd.arg("--spawn").arg("start");
    }
    if let Some(dir) = state_dir(id) {
        cmd.arg("--state-dir").arg(dir);
    }
    // cwd = the server tree: it resolves assets/props.txt against it, exactly as
    // the Electron shell arranges for its own.
    cmd.current_dir(&tree);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW: no console flashing up
    }
    println!("[runner] server: {} --port {} --module {}", bin.display(), port, module.display());
    cmd.spawn()
}

fn js_string(s: &str) -> String {
    serde_json::Value::String(s.to_string()).to_string()
}

#[tauri::command]
fn up(data: String, link: tauri::State<'_, Arc<Link>>) {
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(data) else { return };
    let mut guard = link.stream.lock().unwrap();
    match guard.as_mut() {
        Some(s) => {
            if s.write_all(&bytes).is_err() {
                *guard = None;
            }
        }
        None => link.pending.lock().unwrap().push(bytes),
    }
}

#[tauri::command]
fn close(link: tauri::State<'_, Arc<Link>>) {
    if let Some(s) = link.stream.lock().unwrap().take() {
        let _ = s.shutdown(Shutdown::Both);
    }
}

/// The game asked to quit (a main menu's "Quit": SCREEN_SET's `quit`,
/// docs/protocol.md). Exiting runs RunEvent::Exit below, which stops the
/// game server.
#[tauri::command]
fn quit(app: tauri::AppHandle) {
    println!("[runner] the game asked to quit");
    app.exit(0);
}

#[tauri::command]
fn log(line: String) {
    println!("[page] {line}");
}

fn main() {
    let game = game_dir();
    let conf: serde_json::Value = std::fs::read(game.join("game.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| {
            eprintln!("[runner] no game at {}", game.display());
            std::process::exit(2)
        });
    let web = game.join("web");
    let link = Arc::new(Link { stream: Mutex::new(None), pending: Mutex::new(Vec::new()), server: Mutex::new(None) });
    let port = free_port();
    match start_server(&game, &conf, port) {
        Ok(child) => *link.server.lock().unwrap() = Some(child),
        Err(e) => eprintln!("[runner] the game server did not start: {e}"),
    }

    let link_for_setup = link.clone();
    let title = conf["name"].as_str().unwrap_or("Game").to_string();
    let app = tauri::Builder::default()
        .manage(link.clone())
        .register_uri_scheme_protocol("game", move |_ctx, req| serve(&web, req.uri().path()))
        .invoke_handler(tauri::generate_handler![up, close, log, quit])
        .setup(move |app| {
            // The page's origin: game://localhost on macOS and Linux; WebView2
            // maps a custom scheme to http://game.localhost.
            let url = if cfg!(windows) { "http://game.localhost/index.html" } else { "game://localhost/index.html" };
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url.parse().unwrap()))
                .title(&title)
                .inner_size(1280.0, 800.0)
                .build()?;

            // The link: connect (the server needs a moment to load its maps),
            // flush what the page already sent, then hand every read to the page
            // raw -- shell.js's framing reader copes with any split.
            let link = link_for_setup.clone();
            let win = window.clone();
            thread::spawn(move || {
                let deadline = Instant::now() + Duration::from_secs(60);
                let stream = loop {
                    match TcpStream::connect(("127.0.0.1", port)) {
                        Ok(s) => break Some(s),
                        Err(_) if Instant::now() < deadline => thread::sleep(Duration::from_millis(100)),
                        Err(_) => break None,
                    }
                };
                let Some(mut stream) = stream else {
                    let _ = win.eval("window.__dnpClosed && window.__dnpClosed('the game server did not start')");
                    return;
                };
                let _ = stream.set_nodelay(true);
                println!("[runner] link up on 127.0.0.1:{port}");
                {
                    let mut w = stream.try_clone().expect("clone");
                    for b in link.pending.lock().unwrap().drain(..) {
                        let _ = w.write_all(&b);
                    }
                    *link.stream.lock().unwrap() = Some(w);
                }
                let mut buf = vec![0u8; 1 << 16];
                loop {
                    match stream.read(&mut buf) {
                        Ok(0) | Err(_) => {
                            let _ = win.eval("window.__dnpClosed && window.__dnpClosed('the game server stopped')");
                            break;
                        }
                        Ok(n) => {
                            let b64 = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                            let _ = win.eval(&format!("window.__dnpDown && window.__dnpDown({})", js_string(&b64)));
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri");

    app.run(move |_app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut c) = link.server.lock().unwrap().take() {
                println!("[runner] stopping the game server");
                let _ = c.kill();
                let _ = c.wait();
            }
        }
    });
}
