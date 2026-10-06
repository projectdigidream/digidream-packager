package com.digidream.packager;

import android.app.Activity;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInstaller;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * The packager on a phone.
 *
 * The page (packager/index.html and src/) is served out of the APK's assets
 * from https://appassets.androidplatform.net/ -- a reserved name that never
 * resolves, so every request is answered here, and an https origin is a
 * SECURE context, which WebCrypto (signing), OPFS (the kit store) and
 * CompressionStream need.
 *
 * What the page gets from this shell (window.packagerHost, see
 * assets/www/android-host.js and src/host.js): files streamed in as base64
 * chunks to a temporary file -- the one thing a JavascriptInterface carries is
 * strings -- then either SAVED through the system's "save as" picker or
 * INSTALLED through PackageInstaller, which asks the user to confirm.
 */
public class MainActivity extends Activity {
    private static final String ORIGIN = "https://appassets.androidplatform.net/";
    private static final int PICK_FILE = 1;
    private static final int SAVE_FILE = 2;
    private static final String ACTION_INSTALLED = "com.digidream.packager.INSTALLED";

    private WebView web;
    private ValueCallback<Uri[]> chooserCallback;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, File> staged = new HashMap<>();
    private int nextId = 1;
    private String pendingSave; // token waiting for the picker's answer

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        // Inspectable over USB when the APK is debuggable: how the tests drive it.
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debuggable);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(true);
        web.addJavascriptInterface(new Bridge(), "PackagerAndroid");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
                return serve(req.getUrl());
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (chooserCallback != null) chooserCallback.onReceiveValue(null);
                chooserCallback = cb;
                Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                i.addCategory(Intent.CATEGORY_OPENABLE);
                i.setType("*/*");
                startActivityForResult(i, PICK_FILE);
                return true;
            }
        });
        setContentView(web);
        listenForInstalls();
        web.loadUrl(ORIGIN + "index.html");
    }

    // ---- the page, from assets/www ------------------------------------------

    private WebResourceResponse serve(Uri url) {
        if (!"appassets.androidplatform.net".equals(url.getHost())) {
            // Nothing leaves the phone: anything else is refused, not fetched.
            return new WebResourceResponse("text/plain", "utf-8", 404, "Not here", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
        }
        String path = url.getPath();
        if (path == null || path.equals("/")) path = "/index.html";
        if (path.contains("..")) return notFound();
        try {
            InputStream in = getAssets().open("www" + path);
            if (path.equals("/index.html")) {
                // The shell's host goes in first, as a classic script, so that
                // window.packagerHost exists before the page's modules run.
                String html = new String(readAll(in), "UTF-8");
                html = html.replace("<script type=\"module\"", "<script src=\"android-host.js\"></script>\n<script type=\"module\"");
                in = new ByteArrayInputStream(html.getBytes("UTF-8"));
            }
            Map<String, String> headers = new HashMap<>();
            headers.put("Cache-Control", "no-store");
            return new WebResourceResponse(mime(path), mime(path).startsWith("text/") ? "utf-8" : null, 200, "OK", headers, in);
        } catch (IOException e) {
            return notFound();
        }
    }

    private static WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found", new HashMap<String, String>(), new ByteArrayInputStream(new byte[0]));
    }

    private static String mime(String p) {
        if (p.endsWith(".html")) return "text/html";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "text/javascript";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".zip")) return "application/zip";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".svg")) return "image/svg+xml";
        return "application/octet-stream";
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream b = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[65536];
        int n;
        while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
        in.close();
        return b.toByteArray();
    }

    // ---- what the page calls ------------------------------------------------

    private class Bridge {
        /** A new staged file; returns its token. */
        @JavascriptInterface
        public String begin() {
            synchronized (staged) {
                String t = "f" + (nextId++);
                File f = new File(getCacheDir(), "staged-" + t);
                f.delete();
                staged.put(t, f);
                return t;
            }
        }

        /** Append base64 bytes to a staged file. */
        @JavascriptInterface
        public void append(String token, String b64) throws IOException {
            File f;
            synchronized (staged) { f = staged.get(token); }
            if (f == null) throw new IOException("no such staged file");
            try (OutputStream o = new FileOutputStream(f, true)) { o.write(Base64.decode(b64, Base64.DEFAULT)); }
        }

        /** Ask where to save a staged file; the answer comes back through __packagerReply. */
        @JavascriptInterface
        public void save(final String token, final String name, final String type) {
            main.post(new Runnable() {
                public void run() {
                    // A debuggable build with files/autosave present saves to
                    // files/out/ without asking: how the tests save.
                    File auto = new File(getFilesDir(), "autosave");
                    boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
                    if (debuggable && auto.exists()) {
                        File out = new File(new File(getFilesDir(), "out"), name);
                        out.getParentFile().mkdirs();
                        try (InputStream in = new FileInputStream(stagedFile(token)); OutputStream o = new FileOutputStream(out)) {
                            copy(in, o);
                            reply(token, true, out.getAbsolutePath());
                        } catch (IOException e) { reply(token, false, e.getMessage()); }
                        return;
                    }
                    pendingSave = token;
                    Intent i = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType(type == null || type.isEmpty() ? "application/octet-stream" : type);
                    i.putExtra(Intent.EXTRA_TITLE, name);
                    startActivityForResult(i, SAVE_FILE);
                }
            });
        }

        /** Install a staged APK through PackageInstaller; the system asks the user. */
        @JavascriptInterface
        public void install(final String token) {
            new Thread(new Runnable() {
                public void run() {
                    try {
                        File f = stagedFile(token);
                        PackageInstaller pi = getPackageManager().getPackageInstaller();
                        PackageInstaller.SessionParams p = new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);
                        p.setSize(f.length());
                        int id = pi.createSession(p);
                        PackageInstaller.Session session = pi.openSession(id);
                        try (InputStream in = new FileInputStream(f); OutputStream o = session.openWrite("game.apk", 0, f.length())) {
                            copy(in, o);
                            session.fsync(o);
                        }
                        Intent done = new Intent(ACTION_INSTALLED).setPackage(getPackageName()).putExtra("token", token);
                        PendingIntent pend = PendingIntent.getBroadcast(MainActivity.this, id, done,
                                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
                        session.commit(pend.getIntentSender());
                        session.close();
                        reply(token, true, "the system is asking to install it");
                    } catch (Exception e) {
                        reply(token, false, e.toString());
                    }
                }
            }).start();
        }
    }

    private File stagedFile(String token) throws IOException {
        synchronized (staged) {
            File f = staged.get(token);
            if (f == null || !f.exists()) throw new IOException("nothing staged under " + token);
            return f;
        }
    }

    private void reply(final String token, final boolean ok, final String msg) {
        main.post(new Runnable() {
            public void run() {
                String js = "window.__packagerReply && window.__packagerReply(" + q(token) + "," + ok + "," + q(msg) + ")";
                web.evaluateJavascript(js, null);
            }
        });
    }

    private static String q(String s) {
        return "\"" + (s == null ? "" : s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ")) + "\"";
    }

    private static void copy(InputStream in, OutputStream o) throws IOException {
        byte[] buf = new byte[1 << 16];
        int n;
        while ((n = in.read(buf)) > 0) o.write(buf, 0, n);
    }

    // PackageInstaller's answer: when the user must confirm, it hands back the
    // system's confirmation screen to show.
    private final android.content.BroadcastReceiver installed = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            int status = i.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
            if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                Intent confirm = i.getParcelableExtra(Intent.EXTRA_INTENT);
                if (confirm != null) {
                    confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(confirm);
                }
            } else if (status == PackageInstaller.STATUS_SUCCESS) {
                reply(i.getStringExtra("token"), true, "installed");
            } else {
                reply(i.getStringExtra("token"), false, "not installed: " + i.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE));
            }
        }
    };

    // Registered for the activity's whole life, not between onStart and
    // onStop: the system's confirmation screen covers this activity, so the
    // verdict arrives while it is STOPPED -- and Play Protect's check can take
    // a minute after the user says yes.
    private void listenForInstalls() {
        android.content.IntentFilter f = new android.content.IntentFilter(ACTION_INSTALLED);
        if (android.os.Build.VERSION.SDK_INT >= 33) registerReceiver(installed, f, Context.RECEIVER_NOT_EXPORTED);
        else registerReceiver(installed, f);
    }

    @Override
    protected void onDestroy() {
        try { unregisterReceiver(installed); } catch (IllegalArgumentException ignored) { }
        super.onDestroy();
    }

    @Override
    protected void onActivityResult(int request, int result, Intent data) {
        if (request == PICK_FILE) {
            if (chooserCallback != null) {
                Uri u = result == RESULT_OK && data != null ? data.getData() : null;
                chooserCallback.onReceiveValue(u != null ? new Uri[] { u } : null);
                chooserCallback = null;
            }
        } else if (request == SAVE_FILE) {
            final String token = pendingSave;
            pendingSave = null;
            if (token == null) return;
            if (result != RESULT_OK || data == null || data.getData() == null) { reply(token, false, "cancelled"); return; }
            final Uri dest = data.getData();
            new Thread(new Runnable() {
                public void run() {
                    try (InputStream in = new FileInputStream(stagedFile(token)); OutputStream o = getContentResolver().openOutputStream(dest)) {
                        copy(in, o);
                        reply(token, true, dest.toString());
                    } catch (IOException e) { reply(token, false, e.getMessage()); }
                }
            }).start();
        }
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack()) web.goBack(); else super.onBackPressed();
    }
}
