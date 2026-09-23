package com.codexlink.mobile;

import android.content.*;
import android.content.res.AssetFileDescriptor;
import android.database.*;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.*;

/** Isolated Android content provider; exercises the production resolver code without user files/accounts. */
public final class FixtureProvider extends ContentProvider {
    public boolean onCreate(){return true;}
    public String getType(Uri uri){return "application/octet-stream";}
    public Cursor query(Uri uri,String[] projection,String selection,String[] args,String order){
        String scenario=uri.getLastPathSegment();
        if(scenario.equals("query-error"))throw new IllegalArgumentException("Metadata unavailable");
        if(scenario.equals("null-cursor"))return null;
        if(scenario.equals("missing-columns")){MatrixCursor cursor=new MatrixCursor(new String[]{"id"});cursor.addRow(new Object[]{42});return cursor;}
        String name=scenario.equals("normal")?"演示文稿.pptx":scenario.equals("word")?"中文说明":scenario.equals("null-name")?null:"0920-爱我中华，同心筑梦";
        if(scenario.equals("trailing"))name="0920-爱我中华，同心筑梦.pptx\u200b\u00a0 ";
        MatrixCursor cursor=new MatrixCursor(new String[]{OpenableColumns.DISPLAY_NAME,OpenableColumns.SIZE});
        cursor.addRow(new Object[]{name,scenario.equals("large-declared")?ApiClient.MAX_FILE_BYTES+1L:null});return cursor;
    }
    public ParcelFileDescriptor openFile(Uri uri,String mode)throws FileNotFoundException{
        String scenario=uri.getLastPathSegment();
        if(scenario.equals("denied"))throw new SecurityException("Fixture stream unavailable");
        if(scenario.equals("missing-file"))throw new FileNotFoundException("PRIVATE-file-path-should-not-appear");
        if(scenario.equals("pipe")||scenario.equals("read-error"))try{
            ParcelFileDescriptor[] pipe=ParcelFileDescriptor.createReliablePipe();
            new Thread(()->{
                try{
                    OutputStream output=new ParcelFileDescriptor.AutoCloseOutputStream(pipe[1]);
                    if(scenario.equals("read-error")){output.write(new byte[]{80,75,3,4});pipe[1].closeWithError("PRIVATE-provider-error");}
                    else try(InputStream input=getContext().getAssets().open("slides.pptx");OutputStream out=output){byte[] b=new byte[4096];int n;while((n=input.read(b))!=-1)out.write(b,0,n);}
                }catch(IOException ignored){}
            }).start();return pipe[0];
        }catch(IOException error){throw new FileNotFoundException(error.toString());}
        File file=new File(getContext().getCacheDir(),"provider-file");
        try(OutputStream out=new FileOutputStream(file)){
            if(scenario.equals("invalid"))out.write("not a presentation".getBytes("UTF-8"));
            else if(!scenario.equals("empty"))try(InputStream input=getContext().getAssets().open(scenario.equals("word")?"word.docx":"slides.pptx")){
                byte[] b=new byte[4096];int n;while((n=input.read(b))!=-1)out.write(b,0,n);
            }
        }catch(IOException error){throw new FileNotFoundException(error.toString());}
        return ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY);
    }
    public AssetFileDescriptor openAssetFile(Uri uri,String mode)throws FileNotFoundException{
        if(!uri.getLastPathSegment().equals("slice"))return super.openAssetFile(uri,mode);
        File file=new File(getContext().getCacheDir(),"provider-slice");long count=0;
        try(OutputStream out=new FileOutputStream(file);InputStream input=getContext().getAssets().open("slides.pptx")){
            out.write(new byte[17]);byte[] b=new byte[4096];int n;while((n=input.read(b))!=-1){out.write(b,0,n);count+=n;}out.write(new byte[23]);
        }catch(IOException error){throw new FileNotFoundException(error.toString());}
        return new AssetFileDescriptor(ParcelFileDescriptor.open(file,ParcelFileDescriptor.MODE_READ_ONLY),17,count);
    }
    public Uri insert(Uri uri,ContentValues values){throw new UnsupportedOperationException();}
    public int update(Uri uri,ContentValues values,String s,String[] a){throw new UnsupportedOperationException();}
    public int delete(Uri uri,String s,String[] a){throw new UnsupportedOperationException();}
}
