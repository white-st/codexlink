package com.codexlink.mobile;

import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import java.io.*;
import java.nio.file.Files;

/** Read a selected content URI once; release our private copy after upload or any failure. */
final class AttachmentSource {
    static Intent picker(boolean alternate){
        return new Intent(alternate?Intent.ACTION_OPEN_DOCUMENT:Intent.ACTION_GET_CONTENT)
            .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
    }
    static final class ReadFailure extends ApiClient.Failure {
        final String detail;
        ReadFailure(String message,String detail){super(400,"{\"error\":\""+message+"\"}",false);this.detail=detail;}
    }
    private static ReadFailure problem(Uri uri,int flags,String stage,Throwable error){
        String code,message;
        if(stage.equals("open")&&error instanceof SecurityException){code="A01";message="手机文件管理器未授予读取权限，请换一种方式选择文件";}
        else if(stage.equals("open")&&error instanceof FileNotFoundException){code="A02";message="文件管理器未能提供这个文件，请从文件实际保存的位置重新选择";}
        else if(stage.equals("open")){code="A03";message="文件管理器无法打开所选文件，请换一种方式选择";}
        else if(stage.equals("read")){code="A04";message="读取文件中途失败，请重新选择手机里已保存的文件";}
        else if(stage.equals("cache")){code="A05";message="无法在 App 中暂存附件，请检查手机可用空间";}
        else{code="A06";message="文件已读取，但检查文档时出错，请复制诊断信息协助定位";}
        // Never include the URI path/query, filename, exception message or document contents.
        String authority=uri.getAuthority();if(authority==null||!authority.matches("[A-Za-z0-9._-]{1,160}"))authority="unavailable";
        String scheme=uri.getScheme();if(!"content".equals(scheme)&&!"file".equals(scheme))scheme="other";
        String detail="CodexLink attachment "+code+"\nstage="+stage+"\nexception="+error.getClass().getSimpleName()+"\nsource="+scheme+"://"+authority+"\nreadGrant="+((flags&Intent.FLAG_GRANT_READ_URI_PERMISSION)!=0)+"\nAndroid="+android.os.Build.VERSION.SDK_INT;
        return new ReadFailure(message+"（"+code+"）",detail);
    }
    static final class Staged implements AutoCloseable {
        final File file; final String name;
        Staged(File file,String name){this.file=file;this.name=name;}
        public void close()throws IOException{Files.deleteIfExists(file.toPath());}
    }
    static Staged read(ContentResolver resolver,Uri uri,File cache)throws IOException{
        return read(resolver,uri,cache,0);
    }
    static Staged read(ContentResolver resolver,Uri uri,File cache,int resultFlags)throws IOException{
        String displayName=null;long declared=-1;
        // Some document providers omit name/size or reject projected columns; neither is mandatory.
        try(Cursor cursor=resolver.query(uri,null,null,null,null)){
            if(cursor!=null&&cursor.moveToFirst()){
                int n=cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME),s=cursor.getColumnIndex(OpenableColumns.SIZE);
                if(n>=0&&!cursor.isNull(n))displayName=cursor.getString(n);
                if(s>=0&&!cursor.isNull(s))declared=cursor.getLong(s);
            }
        }catch(RuntimeException metadataUnavailable){/* The file stream and its actual type remain authoritative. */}
        if(declared>ApiClient.MAX_FILE_BYTES)throw OfficeAttachment.failure(413,"单个附件不能超过 "+ApiClient.FILE_LIMIT_LABEL);
        File file;
        try{file=File.createTempFile("attachment-",".tmp",cache);}
        catch(IOException|SecurityException error){throw problem(uri,resultFlags,"cache",error);}
        boolean complete=false;
        try{
            InputStream source;
            try{source=resolver.openInputStream(uri);if(source==null)throw new IOException("No content stream");}
            catch(IOException|SecurityException error){throw problem(uri,resultFlags,"open",error);}
            try(InputStream input=new FilterInputStream(source){
                @Override public int read(byte[] b,int offset,int length)throws IOException{
                    try{return in.read(b,offset,length);}
                    catch(IOException|SecurityException error){throw problem(uri,resultFlags,"read",error);}
                }
                @Override public void close()throws IOException{
                    try{super.close();}catch(IOException error){throw problem(uri,resultFlags,"read",error);}
                }
            }){
                try(OutputStream output=new FileOutputStream(file)){ApiClient.copyFile(input,output);}
                catch(ApiClient.Failure error){throw error;}
                catch(IOException|SecurityException error){throw problem(uri,resultFlags,"cache",error);}
            }
            String filename;
            try{filename=OfficeAttachment.filename(file,displayName);}
            catch(ApiClient.Failure error){throw error;}
            catch(IOException|SecurityException error){throw problem(uri,resultFlags,"verify",error);}
            Staged result=new Staged(file,filename);complete=true;return result;
        }finally{if(!complete)Files.deleteIfExists(file.toPath());}
    }
}
