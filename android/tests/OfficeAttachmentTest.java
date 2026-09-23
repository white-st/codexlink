package com.codexlink.mobile;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.zip.*;

public final class OfficeAttachmentTest {
    static void check(boolean value,String message){if(!value)throw new AssertionError(message);}
    static void rejected(File file,int status)throws Exception{
        try{OfficeAttachment.filename(file,"fake.pptx");throw new AssertionError("Invalid file accepted");}
        catch(ApiClient.Failure error){check(error.status==status,"Unexpected error: "+error.getMessage());}
    }
    public static void main(String[] args)throws Exception{
        File word=new File(args[0]),ppt=new File(args[1]);
        byte[] before=Files.readAllBytes(ppt.toPath());
        String oppo="0920-爱我中华，同心筑梦";
        check(!oppo.matches(".+\\.(docx|pptx)$"),"Regression must fail former display-name gate");
        check(OfficeAttachment.filename(ppt,oppo).equals(oppo+".pptx"),"OPPO title without extension");
        for(String name:new String[]{"中文文件.pptx"," 中文文件.PPTX ","中文文件.pptx\u200b\u00a0","\u200f中文文件.pptx\u2066"})
            check(OfficeAttachment.filename(ppt,name).equals("中文文件.pptx"),"Whitespace/case/control metadata: "+name);
        check(OfficeAttachment.filename(ppt,null).equals("演示文稿.pptx"),"Missing metadata");
        check(OfficeAttachment.filename(word,"").equals("Word文档.docx"),"Empty display name");
        check(OfficeAttachment.filename(word,"文档").equals("文档.docx"),"Word without extension");
        check(OfficeAttachment.filename(ppt,"内容.docx").equals("内容.pptx"),"Actual type, not extension");
        check(OfficeAttachment.filename(ppt,"..\\bad:name\nfile.pptx").equals("__bad_name file.pptx"),"Windows unsafe name normalized");
        for(String reserved:new String[]{"CON","aux.docx","LPT2.pptx"})check(OfficeAttachment.filename(ppt,reserved).startsWith("附件_"),"Reserved Windows basename");
        StringBuilder longName=new StringBuilder();for(int i=0;i<150;i++)longName.append("中");longName.append(".pptx");
        check(OfficeAttachment.filename(ppt,longName.toString()).length()==120,"Server name length limit");
        StringBuilder emoji=new StringBuilder();for(int i=0;i<57;i++)emoji.append("中");for(int i=0;i<57;i++)emoji.append("🚀");
        String shortName=OfficeAttachment.filename(ppt,emoji.toString());check(!Character.isHighSurrogate(shortName.charAt(shortName.length()-6)),"No split surrogate");
        check(Arrays.equals(before,Files.readAllBytes(ppt.toPath())),"Document bytes unchanged");
        File invalid=File.createTempFile("office-input-test-",".tmp");
        try{
            rejected(invalid,400);
            Files.write(invalid.toPath(),"not a PowerPoint file".getBytes("UTF-8"));rejected(invalid,415);
            Files.write(invalid.toPath(),new byte[]{(byte)0xd0,(byte)0xcf,0x11,(byte)0xe0,(byte)0xa1,(byte)0xb1,0x1a,(byte)0xe1});rejected(invalid,415);
            Files.write(invalid.toPath(),Arrays.copyOf(before,Math.min(before.length/2,100)));rejected(invalid,415);
            try(ZipOutputStream out=new ZipOutputStream(new FileOutputStream(invalid))){out.putNextEntry(new ZipEntry("not-office.txt"));out.write(1);out.closeEntry();}rejected(invalid,415);
            try(RandomAccessFile out=new RandomAccessFile(invalid,"rw")){out.setLength(ApiClient.MAX_FILE_BYTES+1L);}rejected(invalid,413);
        }finally{Files.deleteIfExists(invalid.toPath());}
        System.out.println("Office selection regression passed: OPPO-style title, missing/Unicode metadata, actual document type, safe names, invalid/legacy/truncated/oversize files, original bytes unchanged.");
    }
}
