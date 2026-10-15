package ru.sphere.flagman;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.text.InputType;
import android.util.Base64;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;
import android.util.Log;
import com.google.android.gms.common.moduleinstall.ModuleInstall;
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest;
import com.google.mlkit.common.MlKitException;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * «Флагман» для Android: склад в WebView — тот же интерфейс, что в браузере, с сервера склада.
 * Адрес сервера — из настроек (по умолчанию BuildConfig.SERVER_URL); сменить — долгое нажатие на иконку
 * → «Адрес сервера» или кнопка на экране «Нет связи со складом». Чего WebView сам не умеет, делаем здесь:
 * фото с камеры для списаний, скачивание файлов, «во весь экран» для кухни.
 */
public class MainActivity extends Activity {

    static final String ACTION_SERVER = "ru.sphere.flagman.SERVER";
    private static final String PREFS = "flagman";
    private static final String KEY_URL = "server_url";
    private static final int REQ_FILE = 1;

    private FrameLayout root;
    private WebView web;
    private ProgressBar progress;
    private View offline;
    private TextView offlineUrl;
    private String bridgeJs;
    private boolean mainFrameFailed;

    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private View fullscreenView;
    private WebChromeClient.CustomViewCallback fullscreenCallback;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        setContentView(R.layout.activity_main);
        root = findViewById(R.id.root);
        web = findViewById(R.id.web);
        progress = findViewById(R.id.progress);
        offline = findViewById(R.id.offline);
        offlineUrl = findViewById(R.id.offline_url);
        findViewById(R.id.retry).setOnClickListener(v -> load());
        findViewById(R.id.change_server).setOnClickListener(v -> askServer());
        bridgeJs = readAsset("bridge.js");
        applyInsets();
        setupWebView();
        prefetchScanner();
        if (state == null || web.restoreState(state) == null) {
            load();
        }
        if (ACTION_SERVER.equals(getIntent().getAction())) {
            askServer();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (ACTION_SERVER.equals(intent.getAction())) {
            askServer();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        CookieManager.getInstance().flush();      // вход сохраняется и после закрытия приложения
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (fullscreenView != null) {
            exitFullscreen();
        } else if (offline.getVisibility() != View.VISIBLE && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }

    // ── Сервер ──────────────────────────────────────────────────────────────

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private String serverUrl() {
        return prefs().getString(KEY_URL, BuildConfig.SERVER_URL);
    }

    private void load() {
        mainFrameFailed = false;
        offline.setVisibility(View.GONE);
        web.setVisibility(View.VISIBLE);
        web.loadUrl(serverUrl() + "/");
    }

    private void showOffline() {
        mainFrameFailed = true;
        offlineUrl.setText(serverUrl());
        offline.setVisibility(View.VISIBLE);
        progress.setVisibility(View.GONE);
    }

    /** Свой сервер — в окне приложения; всё остальное (документация, сайты, почта) — в браузере телефона. */
    private boolean isOurs(Uri u) {
        Uri s = Uri.parse(serverUrl());
        return u.getHost() != null && u.getHost().equalsIgnoreCase(s.getHost())
                && portOf(u) == portOf(s) && String.valueOf(u.getScheme()).equalsIgnoreCase(s.getScheme());
    }

    private static int portOf(Uri u) {
        return u.getPort() != -1 ? u.getPort() : "https".equalsIgnoreCase(u.getScheme()) ? 443 : 80;
    }

    private static String normalize(String raw) {
        String url = raw.trim().replaceAll("/+$", "");
        return url.isEmpty() || url.matches("(?i)^https?://.*") ? url : "http://" + url;
    }

    /** Склад отвечает «UP» на /actuator/health — значит, адрес верный. */
    private static boolean healthy(String url) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url + "/actuator/health").openConnection();
            c.setConnectTimeout(5000);
            c.setReadTimeout(5000);
            if (c.getResponseCode() != 200) {
                return false;
            }
            try (InputStream in = c.getInputStream()) {
                return new String(readAll(in), StandardCharsets.UTF_8).contains("UP");
            }
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) {
                c.disconnect();
            }
        }
    }

    /** Сменить адрес склада: сначала проверяем, что по нему отвечает склад; не отвечает — спрашиваем. */
    private void askServer() {
        EditText input = new EditText(this);
        input.setSingleLine();
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setHint(R.string.server_hint);
        input.setText(serverUrl());
        input.setSelection(input.getText().length());
        FrameLayout box = new FrameLayout(this);
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        box.setPadding(pad, 0, pad, 0);
        box.addView(input);

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.server_title)
                .setMessage(R.string.server_help)
                .setView(box)
                .setPositiveButton(R.string.save, null)
                .setNegativeButton(R.string.cancel, null)
                .create();
        dialog.setOnShowListener(d -> {
            Button save = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
            save.setOnClickListener(v -> {
                String url = normalize(input.getText().toString());
                if (!url.matches("(?i)^https?://[^\\s/]+.*")) {
                    input.setError(getString(R.string.server_bad_url));
                    return;
                }
                save.setEnabled(false);
                toast(getString(R.string.checking));
                new Thread(() -> {
                    boolean ok = healthy(url);
                    runOnUiThread(() -> {
                        save.setEnabled(true);
                        if (ok) {
                            useServer(url);
                            dialog.dismiss();
                        } else {
                            new AlertDialog.Builder(this)
                                    .setMessage(R.string.server_no_answer)
                                    .setPositiveButton(R.string.save_anyway, (d2, w) -> {
                                        useServer(url);
                                        dialog.dismiss();
                                    })
                                    .setNegativeButton(R.string.cancel, null)
                                    .show();
                        }
                    });
                }).start();
            });
        });
        dialog.show();
    }

    private void useServer(String url) {
        prefs().edit().putString(KEY_URL, url).apply();
        load();
        web.clearHistory();
    }

    // ── WebView ─────────────────────────────────────────────────────────────

    private void setupWebView() {
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " FlagmanAndroid/" + BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        web.addJavascriptInterface(new Bridge(), "FlagmanAndroid");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (isOurs(u)) {
                    return false;
                }
                openOutside(u);
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
                if (!mainFrameFailed) {
                    view.evaluateJavascript(bridgeJs, null);
                }
                CookieManager.getInstance().flush();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    showOffline();
                }
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int p) {
                progress.setProgress(p);
                progress.setVisibility(p < 100 ? View.VISIBLE : View.GONE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    startActivityForResult(fileIntent(params), REQ_FILE);
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    callback.onReceiveValue(null);
                }
                return true;
            }

            // «Режим киоска» на кухне: requestFullscreen() в WebView — это свой экран поверх
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (fullscreenView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                fullscreenView = view;
                fullscreenCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT));
                systemBars(false);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });

        web.setDownloadListener((url, userAgent, disposition, mime, length) -> download(url, userAgent, disposition, mime));
    }

    private void exitFullscreen() {
        if (fullscreenView == null) {
            return;
        }
        root.removeView(fullscreenView);
        fullscreenView = null;
        systemBars(true);
        if (fullscreenCallback != null) {
            fullscreenCallback.onCustomViewHidden();
            fullscreenCallback = null;
        }
    }

    private void systemBars(boolean show) {
        if (Build.VERSION.SDK_INT < 30) {
            return;
        }
        WindowInsetsController c = getWindow().getInsetsController();
        if (c == null) {
            return;
        }
        if (show) {
            c.show(WindowInsets.Type.systemBars());
        } else {
            c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            c.hide(WindowInsets.Type.systemBars());
        }
    }

    /**
     * С Android 11 рисуем под системными панелями сами (с Android 15 так обязательно): отступы — по панелям,
     * вырезу камеры и клавиатуре, чтобы поле ввода не пряталось под ней.
     */
    private void applyInsets() {
        if (Build.VERSION.SDK_INT < 30) {
            return;
        }
        getWindow().setDecorFitsSystemWindows(false);
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets i = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout()
                    | WindowInsets.Type.ime());
            v.setPadding(i.left, i.top, i.right, i.bottom);
            return WindowInsets.CONSUMED;
        });
    }

    private void openOutside(Uri u) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, u));
        } catch (ActivityNotFoundException ignored) {
            // нечем открыть — остаёмся на месте
        }
    }

    // ── Фото и файлы для загрузки ───────────────────────────────────────────

    /** Как в мобильном браузере: поле с capture — сразу камера; иначе — галерея или файлы (можно несколько). */
    private Intent fileIntent(WebChromeClient.FileChooserParams params) {
        boolean images = acceptsImages(params.getAcceptTypes());
        cameraUri = null;
        if (images && params.isCaptureEnabled()) {
            Intent camera = cameraIntent();
            if (camera != null) {
                return camera;
            }
        }
        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
        pick.addCategory(Intent.CATEGORY_OPENABLE);
        pick.setType(images ? "image/*" : "*/*");
        if (params.getMode() == WebChromeClient.FileChooserParams.MODE_OPEN_MULTIPLE) {
            pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        Intent chooser = Intent.createChooser(pick, getString(R.string.choose_photo));
        Intent camera = images ? cameraIntent() : null;
        if (camera != null) {
            chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, new Intent[]{camera});
        }
        return chooser;
    }

    private static boolean acceptsImages(String[] types) {
        if (types == null || types.length == 0) {
            return false;
        }
        for (String t : types) {
            if (t != null && (t.startsWith("image/") || t.matches("(?i).*\\.(jpe?g|png|webp|heic)$"))) {
                return true;
            }
        }
        return false;
    }

    /** Снимок пишется в «Фото / Pictures/Flagman» — разрешения на память не нужны (с Android 10). */
    private Intent cameraIntent() {
        if (Build.VERSION.SDK_INT < 29) {
            return null;
        }
        ContentValues v = new ContentValues();
        v.put(MediaStore.Images.Media.DISPLAY_NAME, "flagman_" + System.currentTimeMillis() + ".jpg");
        v.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        v.put(MediaStore.Images.Media.RELATIVE_PATH, Environment.DIRECTORY_PICTURES + "/Flagman");
        Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, v);
        if (uri == null) {
            return null;
        }
        cameraUri = uri;
        Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        i.putExtra(MediaStore.EXTRA_OUTPUT, uri);
        i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return i;
    }

    @Override
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_FILE || fileCallback == null) {
            return;
        }
        Uri[] result = null;
        if (resultCode == RESULT_OK) {
            if (data != null && data.getClipData() != null) {
                result = new Uri[data.getClipData().getItemCount()];
                for (int i = 0; i < result.length; i++) {
                    result[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data != null && data.getData() != null) {
                result = new Uri[]{data.getData()};
            } else if (cameraUri != null) {
                result = new Uri[]{cameraUri};
            }
        }
        boolean cameraUsed = result != null && cameraUri != null && result.length == 1 && cameraUri.equals(result[0]);
        if (cameraUri != null && !cameraUsed) {
            getContentResolver().delete(cameraUri, null, null);      // камеру открыли и закрыли — пустой снимок не нужен
        }
        cameraUri = null;
        fileCallback.onReceiveValue(result);
        fileCallback = null;
    }

    // ── Скачивание ──────────────────────────────────────────────────────────

    /** Файл с сервера (образцы Excel и т. п.) — системным загрузчиком, с той же сессией входа. */
    private void download(String url, String userAgent, String disposition, String mime) {
        if (!url.startsWith("http")) {
            return;                                                    // blob: и data: сохраняет bridge.js
        }
        String name = URLUtil.guessFileName(url, disposition, mime);
        DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) {
            r.addRequestHeader("Cookie", cookie);
        }
        r.addRequestHeader("User-Agent", userAgent);
        r.setMimeType(mime);
        r.setTitle(name);
        r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        if (Build.VERSION.SDK_INT >= 29) {
            r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        } else {
            r.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
        }
        ((DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE)).enqueue(r);
        toast(getString(R.string.download_started, name));
    }

    /** Файл, собранный на странице (CSV заказа поставщику, образцы поставки), — в «Загрузки». */
    private boolean saveToDownloads(byte[] bytes, String name, String mime) {
        try {
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues v = new ContentValues();
                v.put(MediaStore.Downloads.DISPLAY_NAME, name);
                v.put(MediaStore.Downloads.MIME_TYPE, mime);
                v.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, v);
                if (uri == null) {
                    return false;
                }
                try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                    if (out == null) {
                        return false;
                    }
                    out.write(bytes);
                }
            } else {
                File dir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                try (OutputStream out = new FileOutputStream(new File(dir, name))) {
                    out.write(bytes);
                }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    // ── Сканер QR этикеток ──────────────────────────────────────────────────

    /**
     * Готовый экран сканера из сервисов Google Play: камеру открывает он сам, разрешение приложению не нужно.
     * Текст QR уходит странице событием «flagman:qr» — открыть партию решает интерфейс (Layout.tsx).
     */
    private void scanQr() {
        GmsBarcodeScanning.getClient(this, scannerOptions()).startScan()
                .addOnSuccessListener(code -> sendQr(code.getRawValue()))
                .addOnFailureListener(e -> {
                    Log.w("Flagman", "QR scanner failed", e);
                    if (e instanceof MlKitException && ((MlKitException) e).getErrorCode() == MlKitException.UNAVAILABLE) {
                        toast(getString(R.string.scan_downloading));
                        prefetchScanner();
                    } else {
                        toast(getString(R.string.scan_unavailable));
                    }
                });
    }

    private static GmsBarcodeScannerOptions scannerOptions() {
        return new GmsBarcodeScannerOptions.Builder()
                .setBarcodeFormats(Barcode.FORMAT_QR_CODE)
                .enableAutoZoom()
                .build();
    }

    /**
     * Сканер — отдельный модуль сервисов Google Play. Строка в манифесте скачивает его при установке из Google Play;
     * APK ставят вручную — поэтому просим сервисы скачать модуль сами при запуске, к первому нажатию он уже будет.
     */
    private void prefetchScanner() {
        ModuleInstall.getClient(this)
                .installModules(ModuleInstallRequest.newBuilder()
                        .addApi(GmsBarcodeScanning.getClient(this, scannerOptions()))
                        .build())
                .addOnFailureListener(e -> Log.w("Flagman", "QR scanner module install failed", e));
    }

    private void sendQr(String text) {
        if (text == null) {
            return;
        }
        web.evaluateJavascript("window.dispatchEvent(new CustomEvent('flagman:qr', { detail: "
                + org.json.JSONObject.quote(text) + " }))", null);
    }

    /** Мост для bridge.js и интерфейса: сохранить файл, сообщить про печать, открыть сканер QR. */
    private final class Bridge {
        @JavascriptInterface
        public void scanQr() {
            runOnUiThread(MainActivity.this::scanQr);
        }

        @JavascriptInterface
        public void saveFile(String base64, String name, String mime) {
            String safe = name.replaceAll("[\\\\/:*?\"<>|]", "_");
            boolean ok;
            try {
                ok = saveToDownloads(Base64.decode(base64, Base64.DEFAULT), safe, mime);
            } catch (IllegalArgumentException e) {
                ok = false;
            }
            boolean saved = ok;
            runOnUiThread(() -> toast(saved ? getString(R.string.file_saved, safe) : getString(R.string.file_failed)));
        }

        @JavascriptInterface
        public void printUnavailable() {
            runOnUiThread(() -> toast(getString(R.string.print_unavailable)));
        }
    }

    // ── Служебное ───────────────────────────────────────────────────────────

    private void toast(String text) {
        Toast.makeText(this, text, Toast.LENGTH_LONG).show();
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            return new String(readAll(in), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }

    private static byte[] readAll(InputStream in) throws java.io.IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        for (int n; (n = in.read(buf)) != -1; ) {
            out.write(buf, 0, n);
        }
        return out.toByteArray();
    }
}
