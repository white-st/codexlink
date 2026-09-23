package com.codexlink.mobile;

import java.util.*;

/** Small, lossless block parser for streamed Markdown. Unclosed code remains code. */
final class MessageFormat {
    static final class Block {
        final String text, language;final boolean code;
        Block(String text,boolean code,String language){this.text=text;this.code=code;this.language=language;}
    }
    static List<Block> parse(String source){
        List<Block> result=new ArrayList<>();StringBuilder text=new StringBuilder();boolean code=false;String fence="",language="";
        String[] lines=source.replace("\r\n","\n").split("\n",-1);
        for(int i=0;i<lines.length;i++){
            String line=lines[i],trim=line.trim();boolean opening=!code&&(trim.startsWith("```")||trim.startsWith("~~~"));
            boolean closing=code&&trim.matches(java.util.regex.Pattern.quote(fence.charAt(0)+"")+"{"+fence.length()+",}");
            if(opening||closing){
                if(text.length()>0){result.add(new Block(removeFinalNewline(text.toString()),code,language));text.setLength(0);}
                if(opening){int end=0;while(end<trim.length()&&trim.charAt(end)==trim.charAt(0))end++;fence=trim.substring(0,end);language=trim.substring(end).trim();code=true;}
                else{code=false;language="";}
            }else{text.append(line);if(i<lines.length-1)text.append('\n');}
        }
        if(text.length()>0)result.add(new Block(text.toString(),code,language));return result;
    }
    private static String removeFinalNewline(String text){return text.endsWith("\n")?text.substring(0,text.length()-1):text;}
    static String skillMessage(String source){
        String[][] skills={{"documents:documents","Word 文档"},{"presentations:Presentations","PPT 演示"},{"spreadsheets:Spreadsheets","Excel 表格"},{"pdf:pdf","PDF 处理"},{"development-workflow:development-workflow","软件开发"}};
        for(String[] skill:skills){String prefix="$"+skill[0]+"\n";if(source.startsWith(prefix))return "技能："+skill[1]+"\n"+source.substring(prefix.length());}
        return source;
    }
    static String size(long bytes){if(bytes<1024)return bytes+" B";if(bytes<1024*1024)return String.format(Locale.ROOT,"%.1f KB",bytes/1024.0);return String.format(Locale.ROOT,"%.1f MB",bytes/(1024.0*1024));}
}
