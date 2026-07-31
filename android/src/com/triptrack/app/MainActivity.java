package com.triptrack.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Looper;
import android.os.Message;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import org.json.JSONObject;

public class MainActivity extends Activity {
  // Default: the public address of the TripTrack server (router forwards 3600
  // to gps-server), so the app works on mobile data as well as WiFi.
  // Override without rebuilding via:
  //   adb shell am start -n com.triptrack.app/.MainActivity -e server_url http://<host>:<port>
  // (In the emulator, use http://10.0.2.2:3600 — the host-loopback alias.)
  // Only http(s) URLs are accepted — MainActivity is exported (required for the
  // launcher icon to work), so any other installed app can start it with an
  // arbitrary `server_url` extra; restricting the scheme blocks file:// / content:// /
  // javascript: etc. from being loaded, though a malicious app can still point this at
  // an attacker-run http(s) host to phish the login form (there's no JS bridge exposed
  // to that page, so the blast radius stops at whatever the user types into it).
  private static final String DEFAULT_SERVER_URL = "http://116.74.77.22:3600";
  private static final int FILE_CHOOSER_REQUEST_CODE = 51426;
  private static final int LOCATION_PERMISSION_REQUEST_CODE = 51427;

  private WebView webView;
  private String serverUrl;
  private ValueCallback<Uri[]> filePathCallback;
  // Held between onGeolocationPermissionsShowPrompt (the web page asking for location) and
  // onRequestPermissionsResult (the Android runtime-permission dialog) — the WebView callback
  // has to be answered from whichever of those finishes second.
  private GeolocationPermissions.Callback pendingGeoCallback;
  private String pendingGeoOrigin;
  // Set while LocationBridge.startTracking() is waiting on the runtime-permission dialog, so
  // onRequestPermissionsResult knows to actually start the location updates once it resolves.
  private boolean pendingLocationStart;
  private LocationManager locationManager;

  // navigator.geolocation is blocked by Chromium on insecure origins (WebView is Chromium-based),
  // and the deployed TripTrack server is plain HTTP, not HTTPS — so the Live tab's route tracing
  // can never use the browser Geolocation API in the packaged app. This bridge hands the WebView
  // page JS a direct line to Android's own LocationManager instead, sidestepping that restriction
  // entirely (app.js calls window.AndroidLocation.* when it detects this bridge, and falls back to
  // navigator.geolocation when running in a plain desktop browser where the bridge doesn't exist).
  private final LocationListener locationListener = new LocationListener() {
    @Override
    public void onLocationChanged(Location location) {
      String speed = location.hasSpeed() ? String.valueOf(location.getSpeed()) : "null";
      evaluateJs("window.__triptrackOnLocation && window.__triptrackOnLocation(" + location.getLatitude() + ","
          + location.getLongitude() + "," + location.getAccuracy() + "," + speed + ")");
    }

    @Override
    public void onProviderDisabled(String provider) {
      notifyLocationError("unavailable", "Location provider disabled — turn on location services.");
    }

    @Override
    public void onStatusChanged(String provider, int status, Bundle extras) {}

    @Override
    public void onProviderEnabled(String provider) {}
  };

  private class LocationBridge {
    @JavascriptInterface
    public void startTracking() {
      runOnUiThread(new Runnable() {
        public void run() {
          beginLocationUpdates();
        }
      });
    }

    @JavascriptInterface
    public void stopTracking() {
      runOnUiThread(new Runnable() {
        public void run() {
          if (locationManager != null) {
            locationManager.removeUpdates(locationListener);
          }
        }
      });
    }
  }

  private void evaluateJs(String script) {
    webView.evaluateJavascript(script, null);
  }

  private void notifyLocationError(String code, String message) {
    evaluateJs("window.__triptrackOnLocationError && window.__triptrackOnLocationError("
        + JSONObject.quote(code) + "," + JSONObject.quote(message) + ")");
  }

  private void beginLocationUpdates() {
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED) {
      pendingLocationStart = true;
      requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION }, LOCATION_PERMISSION_REQUEST_CODE);
      return;
    }
    locationManager = (LocationManager) getSystemService(LOCATION_SERVICE);
    boolean gpsEnabled = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
    boolean networkEnabled = locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
    if (!gpsEnabled && !networkEnabled) {
      notifyLocationError("unavailable", "Turn on location services to trace your route.");
      return;
    }
    try {
      if (gpsEnabled) {
        locationManager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 2000, 2, locationListener, Looper.getMainLooper());
      }
      if (networkEnabled) {
        locationManager.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, 2000, 2, locationListener, Looper.getMainLooper());
      }
    } catch (SecurityException e) {
      notifyLocationError("denied", "Location permission denied — allow location access to trace your route.");
    }
  }

  private static boolean isHttpUrl(String url) {
    if (url == null) {
      return false;
    }
    Uri uri = Uri.parse(url);
    String scheme = uri.getScheme();
    return ("http".equals(scheme) || "https".equals(scheme)) && uri.getHost() != null;
  }

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    String fromIntent = getIntent().getStringExtra("server_url");
    serverUrl = isHttpUrl(fromIntent) ? fromIntent : DEFAULT_SERVER_URL;

    webView = new WebView(this);
    WebSettings settings = webView.getSettings();
    settings.setJavaScriptEnabled(true);
    settings.setDomStorageEnabled(true);
    // The supplier "Map" link (and anything else with target="_blank") opens a new window —
    // WebView drops that silently unless multi-window support + onCreateWindow are wired up.
    settings.setSupportMultipleWindows(true);
    settings.setJavaScriptCanOpenWindowsAutomatically(true);
    // Kept for completeness (see onGeolocationPermissionsShowPrompt below), though the Live tab
    // itself talks to AndroidLocation, not navigator.geolocation — see the bridge's own comment.
    settings.setGeolocationEnabled(true);
    webView.addJavascriptInterface(new LocationBridge(), "AndroidLocation");
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
      // The Live tab's navigator.geolocation.watchPosition() surfaces here instead of a
      // browser-style permission popup. Grant it immediately if the OS-level runtime permission
      // is already held; otherwise ask for that first and answer this callback from whichever
      // of onRequestPermissionsResult / this method runs second.
      @Override
      public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
          callback.invoke(origin, true, false);
          return;
        }
        pendingGeoCallback = callback;
        pendingGeoOrigin = origin;
        requestPermissions(new String[] { Manifest.permission.ACCESS_FINE_LOCATION }, LOCATION_PERMISSION_REQUEST_CODE);
      }

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

      // Without this, WebView's <input type="file"> (used by the supplier/data import
      // pickers) never opens a chooser — the tap is silently swallowed, exactly like
      // confirm()/alert() were before WebChromeClient was added for those.
      @Override
      public boolean onShowFileChooser(
          WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
        if (filePathCallback != null) {
          filePathCallback.onReceiveValue(null);
        }
        filePathCallback = callback;
        try {
          startActivityForResult(params.createIntent(), FILE_CHOOSER_REQUEST_CODE);
        } catch (ActivityNotFoundException e) {
          filePathCallback = null;
          return false;
        }
        return true;
      }

      // The supplier "Map" link uses target="_blank" (rel="noopener") so tapping it doesn't
      // navigate the app itself away to Google/Amap/Baidu Maps. WebView's default behavior
      // for a new-window request with nothing handling it is to silently do nothing — no
      // error, the tap just appears dead. Hand the URL off to whatever app the device has
      // registered for it (a maps app, or the browser) instead.
      @Override
      public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
        WebView target = new WebView(MainActivity.this);
        target.setWebViewClient(new WebViewClient() {
          @Override
          public boolean shouldOverrideUrlLoading(WebView innerView, WebResourceRequest request) {
            try {
              startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()));
            } catch (ActivityNotFoundException e) {
              // No app can handle it (e.g. no browser installed) — nothing we can do.
            }
            return true;
          }
        });
        WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
        transport.setWebView(target);
        resultMsg.sendToTarget();
        return true;
      }
    });
    setContentView(webView);
    webView.loadUrl(serverUrl);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == FILE_CHOOSER_REQUEST_CODE) {
      if (filePathCallback != null) {
        filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        filePathCallback = null;
      }
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    if (requestCode == LOCATION_PERMISSION_REQUEST_CODE) {
      boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
      if (pendingGeoCallback != null) {
        pendingGeoCallback.invoke(pendingGeoOrigin, granted, false);
        pendingGeoCallback = null;
        pendingGeoOrigin = null;
      }
      if (pendingLocationStart) {
        pendingLocationStart = false;
        if (granted) {
          beginLocationUpdates();
        } else {
          notifyLocationError("denied", "Location permission denied — allow location access to trace your route.");
        }
      }
      return;
    }
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
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
