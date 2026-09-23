package com.codexlink.mobile;

import android.app.*;
import android.content.*;
import android.content.pm.PackageInstaller;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.provider.Settings;
import android.view.View;
import android.widget.*;
import java.io.*;
import java.lang.ref.WeakReference;
import java.nio.file.Files;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicBoolean;

/** Download/verification and system installation are separate from task execution. */
public final class UpdateActivity extends Activity {
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private final AtomicBoolean cancelled=new AtomicBoolean();
    private ReleaseInfo release;
    private File apk;
    private TextView status;
    private ProgressBar progress;
    private Button action,verifyConnection;
    private ChatUi ui;
    private boolean closed,resumed,downloading,staging,downloaded,permissionOpened,confirmationLaunched;
    private int lastPercent=-1;
    @Override public void onCreate(Bundle saved){
        super.onCreate(saved);ui=new ChatUi(this);
        LinearLayout root=new LinearLayout(this);root.setOrientation(LinearLayout.VERTICAL);root.setBackgroundColor(ChatUi.BG);setContentView(root);Screen.insets(this,root);
        LinearLayout header=new LinearLayout(this);header.setGravity(android.view.Gravity.CENTER_VERTICAL);header.setBackgroundColor(Color.WHITE);
        header.addView(ui.iconButton("back","返回",this::leave),new LinearLayout.LayoutParams(dp(48),dp(48)));TextView title=label("软件更新",19,ChatUi.INK);header.addView(title);root.addView(header);
        ScrollView scroll=new ScrollView(this);LinearLayout content=new LinearLayout(this);content.setOrientation(LinearLayout.VERTICAL);content.setPadding(dp(22),dp(24),dp(22),dp(24));scroll.addView(content);root.addView(scroll,new LinearLayout.LayoutParams(-1,0,1));
        status=label("正在准备更新…",14,ChatUi.MUTED);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setMax(100);progress.setProgressTintList(android.content.res.ColorStateList.valueOf(ChatUi.GREEN));
        action=new Button(this);ui.button(action,true);action.setText("正在下载…");action.setEnabled(false);action.setOnClickListener(v->{if(!downloading&&!staging){if(downloaded)prepareInstall();else download();}});
        verifyConnection=new Button(this);ui.button(verifyConnection,false);verifyConnection.setText("连接验证");verifyConnection.setVisibility(View.GONE);verifyConnection.setOnClickListener(v->startActivity(new Intent(this,VerificationActivity.class)));
        try{
            release=UpdatePackage.parse(getIntent().getStringExtra("release"));
            if(!release.newerThan(UpdatePackage.installed(this).versionCode))throw new IOException("当前已是此版本或更新版本");
            if(release.minSdk>Build.VERSION.SDK_INT)throw new IOException("此版本需要更高版本的安卓系统");
            content.addView(label("CodexLink "+release.version,24,ChatUi.INK));content.addView(label("当前版本 "+UpdatePackage.version(this)+" · "+MessageFormat.size(release.size),13,ChatUi.MUTED));content.addView(label(release.notes,16,ChatUi.INK));
            content.addView(status);content.addView(progress,new LinearLayout.LayoutParams(-1,dp(8)));content.addView(action,new LinearLayout.LayoutParams(-1,dp(52)));content.addView(verifyConnection);
            content.addView(label("安装时按安卓提示确认。更新会重新打开 App，账号、项目和电脑文件保留。",13,ChatUi.MUTED));
            download();
        }catch(Exception error){content.addView(label(error.getMessage()==null?"更新信息已失效，请返回重新检查":error.getMessage(),16,ChatUi.INK));}
        if(Build.VERSION.SDK_INT>=33)getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0,this::leave);
    }
    private int dp(int value){return (int)(value*getResources().getDisplayMetrics().density+.5f);}
    private TextView label(String text,int size,int color){TextView view=new TextView(this);view.setText(text);view.setTextSize(size);view.setTextColor(color);view.setPadding(0,dp(8),0,dp(12));return view;}
    private void download(){
        downloading=true;downloaded=false;cancelled.set(false);action.setEnabled(false);action.setText("正在下载…");verifyConnection.setVisibility(View.GONE);status.setText("正在下载安装包…");progress.setProgress(0);lastPercent=-1;
        worker.execute(()->{
            File target=null;boolean success=false;Exception failure=null;
            try{
                target=File.createTempFile("codexlink-update-",".apk",getCacheDir());apk=target;
                new ApiClient(ApiClient.ORIGIN,new AppCookies()).downloadUpdate(release.filename,target,(bytes,total)->{
                    if(cancelled.get())throw new InterruptedIOException("更新已取消");
                    if(bytes>release.size)throw new IOException("安装包大小与更新信息不符");
                    int percent=(int)(bytes*100/release.size);
                    if(percent!=lastPercent){lastPercent=percent;runOnUiThread(()->{if(!closed){progress.setProgress(percent);status.setText("正在下载 "+percent+"%");}});}
                });
                if(cancelled.get())throw new InterruptedIOException("更新已取消");
                runOnUiThread(()->{if(!closed)status.setText("正在校验安装包…");});UpdatePackage.verify(this,release,target);success=true;
            }catch(Exception error){failure=error;}
            finally{if(!success||cancelled.get()){if(target!=null)try{Files.deleteIfExists(target.toPath());}catch(IOException error){if(failure==null)failure=error;}}}
            final boolean ok=success&&!cancelled.get();final Exception error=failure;
            runOnUiThread(()->{downloading=false;if(closed)return;if(ok){downloaded=true;status.setText("下载完成，安装包校验通过");action.setText("确认安装");action.setEnabled(true);if(resumed)prepareInstall();}else{status.setText(downloadError(error));verifyConnection.setVisibility(error instanceof ApiClient.Failure&&((ApiClient.Failure)error).verification?View.VISIBLE:View.GONE);action.setText("重新下载");action.setEnabled(true);}});
        });
    }
    private String downloadError(Exception error){
        if(error instanceof ApiClient.Failure&&((ApiClient.Failure)error).verification)return "需要先完成 DDNSTO 连接验证，验证后可重新下载";
        return "更新未完成："+(error==null?"请重试":error.getMessage()==null?"请检查网络和手机空间后重试":error.getMessage());
    }
    private void prepareInstall(){
        if(!downloaded||staging||closed)return;
        if(!getPackageManager().canRequestPackageInstalls()){
            status.setText("首次更新需允许 CodexLink 安装新版。开启后返回这里，原有账号和文件不会改变。");action.setText("允许安装并继续");action.setEnabled(true);
            if(!permissionOpened){permissionOpened=true;return;}
            try{startActivityForResult(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,Uri.parse("package:"+getPackageName())),41);}catch(ActivityNotFoundException error){status.setText("请在手机设置中允许 CodexLink 安装应用，然后返回重试");}
            return;
        }
        stageInstall();
    }
    private void stageInstall(){
        staging=true;action.setEnabled(false);status.setText("正在准备安卓安装确认…");
        worker.execute(()->{
            PackageInstaller installer=getPackageManager().getPackageInstaller();int sessionId=-1;boolean committed=false;Exception failure=null;
            try{
                UpdatePackage.verify(this,release,apk);
                int previous=UpdateReceiver.state(this).getInt("session",-1);
                if(previous>=0){PackageInstaller.SessionInfo old=installer.getSessionInfo(previous);if(old!=null&&getPackageName().equals(old.getInstallerPackageName()))installer.abandonSession(previous);}
                UpdateReceiver.confirmation=null;
                PackageInstaller.SessionParams params=new PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL);params.setAppPackageName(getPackageName());params.setSize(release.size);
                if(Build.VERSION.SDK_INT>=31)params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED);
                sessionId=installer.createSession(params);
                try(PackageInstaller.Session session=installer.openSession(sessionId)){
                    try(InputStream in=new FileInputStream(apk);OutputStream out=session.openWrite("base.apk",0,release.size)){
                        byte[] buffer=new byte[65536];int n;while((n=in.read(buffer))!=-1){if(cancelled.get()||Thread.currentThread().isInterrupted())throw new InterruptedIOException("更新已取消");out.write(buffer,0,n);}session.fsync(out);
                    }
                    if(cancelled.get())throw new InterruptedIOException("更新已取消");
                    if(!UpdateReceiver.state(this).edit().putInt("session",sessionId).putInt("target",release.versionCode).putInt("status",-99).commit())throw new IOException("无法保存安装状态，请重试");
                    Intent callback=new Intent(this,UpdateReceiver.class).setAction(getPackageName()+".UPDATE_RESULT");
                    int flags=PendingIntent.FLAG_UPDATE_CURRENT|(Build.VERSION.SDK_INT>=31?PendingIntent.FLAG_MUTABLE:0);
                    PendingIntent result=PendingIntent.getBroadcast(this,sessionId,callback,flags);session.commit(result.getIntentSender());committed=true;
                }
            }catch(Exception error){failure=error;}
            finally{if(!committed&&sessionId>=0){try{installer.abandonSession(sessionId);}catch(RuntimeException error){android.util.Log.w("CodexLinkUpdate","Failed to abandon install session",error);}UpdateReceiver.state(this).edit().remove("session").apply();}}
            final Exception error=failure;runOnUiThread(()->{if(closed)return;if(error!=null){staging=false;status.setText("未能开始安装："+error.getMessage());action.setText("重试安装");action.setEnabled(true);}else installResult();});
        });
    }
    void installResult(){
        if(closed||!resumed||release==null)return;
        SharedPreferences saved=UpdateReceiver.state(this);if(saved.getInt("target",-1)!=release.versionCode)return;
        int result=saved.getInt("status",-99);
        if(result==PackageInstaller.STATUS_PENDING_USER_ACTION){
            if(UpdateReceiver.confirmation!=null&&!confirmationLaunched){
                Intent intent=UpdateReceiver.confirmation;UpdateReceiver.confirmation=null;confirmationLaunched=true;status.setText("请在安卓窗口确认安装");
                try{startActivityForResult(intent,42);}catch(RuntimeException error){confirmationLaunched=false;staging=false;status.setText("无法打开安装确认，请返回后重试");action.setEnabled(true);action.setText("重试安装");}
            }else if(!confirmationLaunched){staging=false;status.setText("安装等待确认。如未看到安卓窗口，可点击重试安装");action.setText("重试安装");action.setEnabled(true);}
        }else if(result==PackageInstaller.STATUS_SUCCESS){
            try{if(UpdatePackage.installed(this).versionCode>=release.versionCode){status.setText("更新完成，请重新打开 App");action.setText("打开 App");action.setEnabled(true);action.setOnClickListener(v->{startActivity(new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP));finish();});}else status.setText("安卓正在完成更新，请稍候");}catch(Exception error){status.setText("请重新打开 App 查看更新结果");}
        }else if(result>=PackageInstaller.STATUS_FAILURE){staging=false;confirmationLaunched=false;status.setText(result==PackageInstaller.STATUS_FAILURE_ABORTED?"已取消安装，当前版本仍可使用":"安卓未能完成安装，请检查手机空间或系统提示后重试");action.setText("重试安装");action.setEnabled(true);}
    }
    @Override protected void onResume(){super.onResume();resumed=true;UpdateReceiver.foreground=new WeakReference<>(this);installResult();if(downloaded&&!staging&&!confirmationLaunched&&getPackageManager().canRequestPackageInstalls()){action.setText("确认安装");action.setEnabled(true);}}
    @Override protected void onPause(){resumed=false;if(UpdateReceiver.foreground.get()==this)UpdateReceiver.foreground=new WeakReference<>(null);super.onPause();}
    @Override protected void onActivityResult(int request,int result,Intent data){super.onActivityResult(request,result,data);if(request==41){status.setText(getPackageManager().canRequestPackageInstalls()?"已允许安装，点击确认安装继续":"尚未允许安装，可稍后重试");}else if(request==42){confirmationLaunched=false;installResult();}}
    @Override public void onBackPressed(){leave();}
    private void leave(){if(downloading||staging){new AlertDialog.Builder(this).setTitle("暂不更新？").setMessage("下载会停止，当前版本可继续使用。").setNegativeButton("继续更新",null).setPositiveButton("暂不更新",(d,w)->finish()).show();}else finish();}
    @Override protected void onDestroy(){closed=true;cancelled.set(true);worker.shutdownNow();if(apk!=null)try{Files.deleteIfExists(apk.toPath());}catch(IOException error){android.util.Log.w("CodexLinkUpdate","Temporary update cleanup failed",error);}if(UpdateReceiver.foreground.get()==this)UpdateReceiver.foreground=new WeakReference<>(null);super.onDestroy();}
}
