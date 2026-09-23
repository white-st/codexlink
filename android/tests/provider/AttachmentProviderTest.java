package com.codexlink.mobile;

import android.app.*;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import java.io.*;
import java.security.MessageDigest;
import java.util.Arrays;

public final class AttachmentProviderTest extends Instrumentation {
    @Override public void onCreate(Bundle args){super.onCreate(args);start();}
    private static void check(boolean ok,String message){if(!ok)throw new AssertionError(message);}
    private static byte[] hash(InputStream stream)throws Exception{
        try(InputStream input=stream){MessageDigest digest=MessageDigest.getInstance("SHA-256");byte[] b=new byte[4096];int n;while((n=input.read(b))!=-1)digest.update(b,0,n);return digest.digest();}
    }
    @Override public void onStart(){
        Bundle result=new Bundle();
        try{
            Context context=getTargetContext();File cache=new File(context.getCacheDir(),"staging");check(cache.mkdirs(),"Create isolated staging directory");
            for(boolean alternate:new boolean[]{false,true}){
                Intent picker=AttachmentSource.picker(alternate);
                check(picker.getAction().equals(alternate?Intent.ACTION_OPEN_DOCUMENT:Intent.ACTION_GET_CONTENT),"Verified import route is default; alternate is explicit");
                check(picker.hasCategory(Intent.CATEGORY_OPENABLE)&&picker.getFlags()==Intent.FLAG_GRANT_READ_URI_PERMISSION,"Only single-file read grant requested");
            }
            for(String scenario:new String[]{"normal","no-extension","trailing","null-name","missing-columns","null-cursor","query-error","word","slice","pipe"}){
                String expected=scenario.equals("normal")?"演示文稿.pptx":scenario.equals("word")?"中文说明.docx":scenario.equals("no-extension")||scenario.equals("trailing")||scenario.equals("slice")||scenario.equals("pipe")?"0920-爱我中华，同心筑梦.pptx":"演示文稿.pptx";
                try(AttachmentSource.Staged staged=AttachmentSource.read(context.getContentResolver(),Uri.parse("content://com.codexlink.attachmenttest.files/"+scenario),cache)){
                    check(staged.name.equals(expected),scenario+": filename "+staged.name);
                    check(Arrays.equals(hash(new FileInputStream(staged.file)),hash(context.getAssets().open(scenario.equals("word")?"word.docx":"slides.pptx"))),scenario+": file bytes preserved");
                }
                check(cache.list().length==0,scenario+": stage removed after close");
            }
            for(String scenario:new String[]{"denied","missing-file","read-error","invalid","empty","large-declared"}){
                try(AttachmentSource.Staged ignored=AttachmentSource.read(context.getContentResolver(),Uri.parse("content://com.codexlink.attachmenttest.files/"+scenario),cache)){throw new AssertionError("Must reject "+scenario);}
                catch(ApiClient.Failure error){
                    int expected=scenario.equals("invalid")?415:scenario.equals("large-declared")?413:400;check(error.status==expected,scenario+": status "+error.status);
                    if(scenario.equals("denied")||scenario.equals("missing-file")||scenario.equals("read-error")){
                        check(error instanceof AttachmentSource.ReadFailure,"Typed local failure");String detail=((AttachmentSource.ReadFailure)error).detail;
                        check(detail.contains(scenario.equals("denied")?"A01":scenario.equals("missing-file")?"A02":"A04"),"Accurate phase: "+detail);
                        check(!detail.contains(scenario)&&!detail.contains("PRIVATE"),"No URI path or exception text in diagnostic");
                    }
                }
                check(cache.list().length==0,scenario+": failure cleaned staging");
            }
            File badCache=new File(context.getCacheDir(),"not-a-directory");try(FileOutputStream out=new FileOutputStream(badCache)){out.write(1);}
            try(AttachmentSource.Staged ignored=AttachmentSource.read(context.getContentResolver(),Uri.parse("content://com.codexlink.attachmenttest.files/normal"),badCache)){throw new AssertionError("Bad cache accepted");}
            catch(AttachmentSource.ReadFailure error){check(error.detail.contains("A05"),"Cache failure is distinct");}
            result.putString("result","PASS: 17 native ContentResolver cases plus both picker intents; file slices/pipes, separate grant/open/read/cache failures, private diagnostics, Office detection, byte equality and cleanup.");
            finish(Activity.RESULT_OK,result);
        }catch(Throwable error){result.putString("result","FAIL: "+error);finish(Activity.RESULT_CANCELED,result);}
    }
}
