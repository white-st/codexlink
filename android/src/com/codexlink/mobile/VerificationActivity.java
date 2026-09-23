package com.codexlink.mobile;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.*;
import android.webkit.*;
import android.widget.*;
import java.util.Locale;
import java.util.concurrent.*;
import org.json.JSONObject;

/** Only the tunnel provider's verification uses a WebView. Workbench screens are native. */
public final class VerificationActivity extends Activity {
    private WebView web;
    private TextView info;
    private boolean checking, closed;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(Color.WHITE);setContentView(root);Screen.insets(this,root);
        info=new TextView(this);info.setText("DDNSTO 连接验证\n只需完成网络验证，工作台账号请回到 App 登录。");info.setPadding(24,16,24,12);root.addView(info);
        Button done=new Button(this);done.setText("已完成，返回 App");done.setOnClickListener(v->finish());root.addView(done);
        web=new WebView(this);root.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        WebSettings settings=web.getSettings();settings.setJavaScriptEnabled(true);settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);settings.setAllowContentAccess(false);settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);settings.setGeolocationEnabled(false);settings.setSafeBrowsingEnabled(true);
        settings.setSupportMultipleWindows(false);CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                if(!allowed(request.getUrl())){info.setText("验证跳转需要外部浏览器完成。返回 App 后可重试连接。");if(request.hasGesture()&&"https".equals(request.getUrl().getScheme())){try{startActivity(new Intent(Intent.ACTION_VIEW,request.getUrl()));}catch(Exception ignored){}}return true;}return false;
            }
            @Override public void onReceivedSslError(WebView view,SslErrorHandler handler,SslError error){handler.cancel();info.setText("安全连接未通过，请检查手机时间或网络后重试。");}
            @Override public void onPageFinished(WebView view,String url){ if(ApiClient.ORIGIN.equals(Uri.parse(url).getScheme()+"://"+Uri.parse(url).getHost())) checkConnection(); }
        });
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0,this::finish);
        web.loadUrl(ApiClient.ORIGIN);
    }
    static boolean allowed(Uri uri){
        String host=uri.getHost();if(!"https".equals(uri.getScheme())||host==null||uri.getUserInfo()!=null||uri.getPort()!=-1&&uri.getPort()!=443)return false;
        host=host.toLowerCase(Locale.ROOT);
        return host.equals("ddnsto.com")||host.endsWith(".ddnsto.com")||host.equals("kooldns.cn")||host.endsWith(".kooldns.cn")||host.equals("open.weixin.qq.com");
    }
    private void checkConnection(){
        if(checking||closed)return;checking=true;
        worker.execute(()->{boolean ready=false;try{JSONObject response=new JSONObject(new ApiClient(ApiClient.ORIGIN,new AppCookies()).json("/api/auth",null));ready=response.has("setupRequired");}catch(Exception ignored){}
            final boolean success=ready;runOnUiThread(()->{checking=false;if(!closed&&success)finish();});
        });
    }
    @Override protected void onDestroy(){closed=true;worker.shutdownNow();if(web!=null){web.stopLoading();web.destroy();}super.onDestroy();}
}
