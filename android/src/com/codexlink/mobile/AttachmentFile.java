package com.codexlink.mobile;

import android.graphics.BitmapFactory;
import java.io.*;

/** Detect the staged bytes, not the document provider's filename or MIME hint. */
final class AttachmentFile {
    static String filename(File file,String displayName)throws IOException{
        if(file.length()==0)throw OfficeAttachment.failure(400,"所选文件内容为空，请重新选择");
        if(file.length()>ApiClient.MAX_FILE_BYTES)throw OfficeAttachment.failure(413,"单个附件不能超过 "+ApiClient.FILE_LIMIT_LABEL);
        try(DataInputStream input=new DataInputStream(new FileInputStream(file))){
            if(file.length()>=4){int header=input.readInt();if(header==0x504b0304||header==0xd0cf11e0)return OfficeAttachment.filename(file,displayName);}
        }
        BitmapFactory.Options info=new BitmapFactory.Options();info.inJustDecodeBounds=true;
        BitmapFactory.decodeFile(file.getAbsolutePath(),info);
        String extension="image/jpeg".equals(info.outMimeType)?".jpg":"image/png".equals(info.outMimeType)?".png":"image/webp".equals(info.outMimeType)?".webp":null;
        if(extension==null||info.outWidth<=0||info.outHeight<=0)throw OfficeAttachment.failure(415,"请选择 JPG、PNG、WebP 图片或 Word/PPT 文件；HEIC、GIF 请先转换格式");
        return OfficeAttachment.normalizeName(displayName,extension);
    }
}
