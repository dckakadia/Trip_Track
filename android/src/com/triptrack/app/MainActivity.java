package com.triptrack.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.os.Bundle;
import android.webkit.JsResult;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

public class MainActivity extends Activity {
  // Default: the public address of the TripTrack server (router forwards 3600
  // to gps-server), so the app works on mobile data as well as WiFi.
  // Override without rebuilding via:
  //   adb shell am start -n com.triptrack.app/.MainActivity -e server_url http://<host>:<port>
  // (In the emulator, use http://10.0.2.2:3600 — the host-loopback alias.)
  private static final String DEFAULT_SERVER_URL = "http://116.74.77.22:3600";

  private WebView webView;
  private String serverUrl;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    String fromIntent = getIntent().getStringExtra("server_url");
    serverUrl = fromIntent != null ? fromIntent : DEFAULT_SERVER_URL;

    webView = new WebView(this);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    webView.setWebViewClient(new WebViewClient() {
      @Override
      public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
        if (request.isForMainFrame()) {
          String html = "<html><body style=\"font-family:sans-serif;padding:2rem;background:#f4f5f7\">"
              + "<h2>TripTrack server unreachable</h2>"
              + "<p>Could not reach <b>" + serverUrl + "</b>.</p>"
              + "<p>Start it on your computer with:<br><code>cd frontend &amp;&amp; npm start</code></p>"
              + "<p><a href=\"" + serverUrl + "\">Retry</a></p>"
              + "</body></html>";
          view.loadDataWithBaseURL(serverUrl, html, "text/html", "utf-8", null);
        }
      }
    });
    // Without a WebChromeClient, WebView never shows window.confirm()/alert()
    // dialogs — the call returns immediately as if cancelled. The web UI uses
    // confirm() for delete buttons (suppliers, users), so those would silently
    // no-op in the packaged app without this.
    webView.setWebChromeClient(new WebChromeClient() {
      @Override
      public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
        new AlertDialog.Builder(MainActivity.this)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, new android.content.DialogInterface.OnClickListener() {
              public void onClick(android.content.DialogInterface dialog, int which) {
                result.confirm();
              }
            })
            .setNegativeButton(android.R.string.cancel, new android.content.DialogInterface.OnClickListener() {
              public void onClick(android.content.DialogInterface dialog, int which) {
                result.cancel();
              }
            })
            .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
              public void onCancel(android.content.DialogInterface dialog) {
                result.cancel();
              }
            })
            .show();
        return true;
      }

      @Override
      public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
        new AlertDialog.Builder(MainActivity.this)
            .setMessage(message)
            .setPositiveButton(android.R.string.ok, new android.content.DialogInterface.OnClickListener() {
              public void onClick(android.content.DialogInterface dialog, int which) {
                result.confirm();
              }
            })
            .setOnCancelListener(new android.content.DialogInterface.OnCancelListener() {
              public void onCancel(android.content.DialogInterface dialog) {
                result.confirm();
              }
            })
            .show();
        return true;
      }
    });
    setContentView(webView);
    webView.loadUrl(serverUrl);
  }

  @Override
  public void onBackPressed() {
    if (webView.canGoBack()) {
      webView.goBack();
    } else {
      super.onBackPressed();
    }
  }
}
