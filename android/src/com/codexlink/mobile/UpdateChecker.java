package com.codexlink.mobile;

import android.app.*;
import android.content.Intent;
import android.os.Build;
import java.util.concurrent.*;
import java.util.function.*;

/** One quiet startup check; prompts wait for a safe foreground moment. */
final class UpdateChecker {
    private final Activity activity;
    private final ApiClient api;
    private final BooleanSupplier ready;
    private final Consumer<AlertDialog> show;
    private final Consumer<String> notice;
    private final ExecutorService worker=Executors.newSingleThreadExecutor();
    private boolean checked,checking,closed;
    private String pending;
    UpdateChecker(Activity activity,ApiClient api,BooleanSupplier ready,Consumer<AlertDialog> show,Consumer<String> notice){this.activity=activity;this.api=api;this.ready=ready;this.show=show;this.notice=notice;}
    void tick(){if(closed||!ready.getAsBoolean())return;if(pending!=null){String release=pending;pending=null;offer(release);}else if(!checked)check(false);}
    void check(boolean manual){
        if(closed)return;if(checking){if(manual)notice.accept("正在检查更新…");return;}
        checked=true;checking=true;if(manual)notice.accept("正在检查更新…");
        worker.execute(()->{
            String raw=null,message=null;boolean verification=false;
            try{
                String text=api.release();ReleaseInfo release=UpdatePackage.parse(text);
                if(!release.newerThan(UpdatePackage.installed(activity).versionCode))message="已是最新版本 "+UpdatePackage.version(activity);
                else if(release.minSdk>Build.VERSION.SDK_INT)message="新版需要更高版本的安卓系统，当前版本可继续使用";
                else raw=text;
            }catch(Exception error){verification=error instanceof ApiClient.Failure&&((ApiClient.Failure)error).verification;message=verification?"请先完成 DDNSTO 连接验证，再检查更新":"暂时无法检查更新，请确认电脑工作台在线后重试";}
            final String result=raw,info=message;final boolean verify=verification;
            activity.runOnUiThread(()->{
                checking=false;if(closed)return;
                if(result!=null){pending=result;tick();if(manual&&pending!=null)notice.accept("已发现新版本，结束当前编辑或关闭弹窗后会提示更新");}
                else if(manual){
                    if(verify)show.accept(new AlertDialog.Builder(activity).setTitle("需要连接验证").setMessage(info).setNegativeButton("稍后",null).setPositiveButton("连接验证",(d,w)->activity.startActivity(new Intent(activity,VerificationActivity.class))).create());
                    else notice.accept(info);
                }
            });
        });
    }
    private void offer(String raw){
        try{
            ReleaseInfo release=UpdatePackage.parse(raw);
            show.accept(new AlertDialog.Builder(activity).setTitle("发现新版本 "+release.version).setMessage(release.notes+"\n\n安装包 "+MessageFormat.size(release.size)+"。确认后在 App 内下载并安装，账号和项目保留。")
                .setNegativeButton("稍后",null).setPositiveButton("立即更新",(d,w)->activity.startActivity(new Intent(activity,UpdateActivity.class).putExtra("release",raw))).create());
        }catch(Exception error){notice.accept("更新信息已失效，请重新检查");}
    }
    void close(){closed=true;worker.shutdownNow();}
}
