package com.codexlink.mobile;

import java.io.*;
import java.util.Locale;
import java.util.zip.ZipFile;
import java.util.zip.ZipException;

/** Identify the staged document, independently of a provider's display name or MIME hint. */
final class OfficeAttachment {
    static ApiClient.Failure failure(int status,String message){
        return new ApiClient.Failure(status,"{\"error\":\""+message+"\"}",false);
    }
    static String filename(File file,String displayName)throws IOException{
        if(file.length()==0)throw failure(400,"所选文件内容为空，请重新选择");
        if(file.length()>ApiClient.MAX_FILE_BYTES)throw failure(413,"单个附件不能超过 "+ApiClient.FILE_LIMIT_LABEL);
        try(RandomAccessFile input=new RandomAccessFile(file,"r")){
            if(input.length()>=8&&input.readLong()==0xd0cf11e0a1b11ae1L)
                throw failure(415,"所选文件是旧版或加密 Office 文件，请先另存为未加密的 .docx 或 .pptx");
            input.seek(0);
            if(input.length()<4||input.readInt()!=0x504b0304)throw invalid();
        }
        String extension;
        try(ZipFile zip=new ZipFile(file)){
            boolean word=zip.getEntry("word/document.xml")!=null, slides=zip.getEntry("ppt/presentation.xml")!=null;
            if(zip.size()>10000||zip.getEntry("[Content_Types].xml")==null||zip.getEntry("_rels/.rels")==null||word==slides)throw invalid();
            extension=word?".docx":".pptx";
        }catch(ZipException|IllegalArgumentException error){throw invalid();}
        return normalizeName(displayName,extension);
    }
    private static ApiClient.Failure invalid(){return failure(415,"所选文件不是完整的 Word / PPT 文档，请重新选择 .docx 或 .pptx 原文件");}
    static String normalizeName(String displayName,String extension){
        StringBuilder clean=new StringBuilder();
        if(displayName!=null)for(int i=0;i<displayName.length();){
            int cp=displayName.codePointAt(i);i+=Character.charCount(cp);
            if(Character.getType(cp)==Character.FORMAT)continue;
            if(Character.isISOControl(cp)||Character.isWhitespace(cp)||Character.isSpaceChar(cp))clean.append(' ');
            else if("<>:\"/\\|?*".indexOf(cp)>=0)clean.append('_');
            else clean.appendCodePoint(cp);
        }
        String name=clean.toString().trim();
        String lower=name.toLowerCase(Locale.ROOT);
        for(String suffix:new String[]{".docx",".pptx",".doc",".ppt",".jpeg",".jpg",".png",".webp"})if(lower.endsWith(suffix)){name=name.substring(0,name.length()-suffix.length()).trim();break;}
        // The existing server rejects consecutive dots and Windows reserved basenames.
        while(name.contains(".."))name=name.replace("..","_");
        while(name.endsWith(".")||name.endsWith(" "))name=name.substring(0,name.length()-1);
        if(name.isEmpty())name=extension.equals(".pptx")?"演示文稿":extension.equals(".docx")?"Word文档":"图片";
        if(name.matches("(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\..*)?$"))name="附件_"+name;
        int max=120-extension.length();
        if(name.length()>max){int end=max;if(Character.isHighSurrogate(name.charAt(end-1)))end--;name=name.substring(0,end);}
        return name+extension;
    }
}
