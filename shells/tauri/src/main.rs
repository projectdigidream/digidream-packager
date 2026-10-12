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

/// FOCUS, the window and the web view in it (the view as the window's first
/// responder). WebKit grants pointer lock only to a page whose window has
/// focus, and after a cutscene on macOS it can have lost it with nothing in the
/// page able to get it back -- window.focus() does nothing in a WKWebView. The
/// page asks for this before it asks for the pointer (engine client main.js).
#[tauri::command]
async fn focus(window: tauri::WebviewWindow) -> String {
    let before = window.is_focused().unwrap_or(false);
    let _ = window.set_focus();
    let view: &tauri::Webview = window.as_ref();
    let _ = view.set_focus();
    let after = window.is_focused().unwrap_or(false);
    // What the page shows when the lock is still refused, so a report says
    // which layer had lost focus.
    let mut said = format!("window {} -> {}", if before { "focused" } else { "not focused" }, if after { "focused" } else { "not focused" });
    #[cfg(target_os = "macos")]
    {
        said.push_str("; ");
        said.push_str(&reseat_responder(&window));
    }
    println!("[runner] focus: {said}");
    said
}

/// AppKit's own view of focus, and a nudge WebKit cannot miss. WebKit keeps
/// its "focused" and "window active" flags (which pointer lock checks) in the
/// web process and updates them when the window's first responder or key state
/// CHANGES; set_focus() on a view that already is the first responder changes
/// nothing, so a stale flag stays stale. Resigning the responder and taking it
/// back is a change. Runs on the main thread (AppKit's rule), so the command
/// is async and waits for the answer here.
#[cfg(target_os = "macos")]
fn reseat_responder(window: &tauri::WebviewWindow) -> String {
    use objc2::msg_send;
    use objc2::runtime::{AnyClass, AnyObject};
    let (tx, rx) = std::sync::mpsc::channel();
    let posted = window.with_webview(move |wv| unsafe {
        let view = wv.inner() as *mut AnyObject;
        let win = wv.ns_window() as *mut AnyObject;
        let name = |o: *mut AnyObject| -> String {
            if o.is_null() { return "none".into() }
            if o == view { return "the web view".into() }
            (*o).class().name().to_string_lossy().into_owned()
        };
        let app: *mut AnyObject = match AnyClass::get(c"NSApplication") {
            Some(c) => msg_send![c, sharedApplication],
            None => std::ptr::null_mut(),
        };
        let active: bool = if app.is_null() { false } else { msg_send![app, isActive] };
        let key: bool = msg_send![win, isKeyWindow];
        let first: *mut AnyObject = msg_send![win, firstResponder];
        let was = name(first);
        if !active && !app.is_null() {
            let _: () = msg_send![app, activateIgnoringOtherApps: true];
        }
        let _: () = msg_send![win, makeKeyAndOrderFront: std::ptr::null_mut::<AnyObject>()];
        let _: bool = msg_send![win, makeFirstResponder: std::ptr::null_mut::<AnyObject>()];
        let _: bool = msg_send![win, makeFirstResponder: view];
        let now: *mut AnyObject = msg_send![win, firstResponder];
        let _ = tx.send(format!(
            "app {}, key window {}, responder {} -> {}",
            if active { "active" } else { "inactive" }, key, was, name(now)
        ));
    });
    if posted.is_err() { return "no web view".into() }
    rx.recv_timeout(std::time::Duration::from_secs(2)).unwrap_or_else(|_| "AppKit did not answer".into())
}

/// POINTER LOCK IN A WKWebView is the app's to grant: WebKit asks the web
/// view's UI delegate (the private `_webViewDidRequestPointerLock:
/// completionHandler:`) and, if the delegate has no such method, refuses --
/// with "Pointer lock requires the window to have focus.", whatever the focus.
/// wry's delegate has none, so a first-person game could never take the mouse.
/// This adds it to the delegate's class, answering yes, and sets the delegate
/// again: WebKit notes which methods a delegate has only when it is set.
#[cfg(target_os = "macos")]
fn allow_pointer_lock(window: &tauri::WebviewWindow) {
    use objc2::runtime::{AnyObject, Bool, Imp, Sel};
    use objc2::{ffi, msg_send, sel};

    unsafe extern "C-unwind" fn did_request(_this: *mut AnyObject, _cmd: Sel, _view: *mut AnyObject, done: *mut block2::Block<dyn Fn(Bool)>) {
        println!("[runner] pointer lock: granted");
        if let Some(done) = unsafe { done.as_ref() } { done.call((Bool::YES,)); }
    }
    unsafe extern "C-unwind" fn did_lose(_this: *mut AnyObject, _cmd: Sel, _view: *mut AnyObject) {
        println!("[runner] pointer lock: released");
    }

    let _ = window.with_webview(|wv| unsafe {
        let view = wv.inner() as *mut AnyObject;
        let delegate: *mut AnyObject = msg_send![view, UIDelegate];
        if delegate.is_null() { println!("[runner] pointer lock: the web view has no UI delegate"); return }
        let class = (*delegate).class() as *const _ as *mut objc2::runtime::AnyClass;
        let request = sel!(_webViewDidRequestPointerLock:completionHandler:);
        let added = ffi::class_addMethod(class, request, std::mem::transmute::<_, Imp>(did_request as unsafe extern "C-unwind" fn(_, _, _, _)), c"v@:@@?".as_ptr());
        let _ = ffi::class_addMethod(class, sel!(_webViewDidLosePointerLock:), std::mem::transmute::<_, Imp>(did_lose as unsafe extern "C-unwind" fn(_, _, _)), c"v@:@".as_ptr());
        let _: () = msg_send![view, setUIDelegate: std::ptr::null_mut::<AnyObject>()];
        let _: () = msg_send![view, setUIDelegate: delegate];
        println!("[runner] pointer lock: delegate {} it", if added.as_bool() { "taught" } else { "already had" });
    });
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
        .invoke_handler(tauri::generate_handler![up, close, log, quit, focus])
        .setup(move |app| {
            // The page's origin: game://localhost on macOS and Linux; WebView2
            // maps a custom scheme to http://game.localhost.
            let url = if cfg!(windows) { "http://game.localhost/index.html" } else { "game://localhost/index.html" };
            let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::CustomProtocol(url.parse().unwrap()))
                .title(&title)
                .inner_size(1280.0, 800.0)
                .focused(true)
                .build()?;
            // FOCUSED FROM THE START, the page as well as the window: WebKit
            // refuses pointer lock ("requires window to have focus") to a page
            // without it, and a first-person game asks on the first click.
            let _ = window.set_focus();
            let view: &tauri::Webview = window.as_ref();
            let _ = view.set_focus();
            #[cfg(target_os = "macos")]
            allow_pointer_lock(&window);

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
