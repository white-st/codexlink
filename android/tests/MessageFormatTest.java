package com.codexlink.mobile;

import java.util.*;

public final class MessageFormatTest {
    static void check(boolean condition,String message){if(!condition)throw new AssertionError(message);}
    public static void main(String[] args){
        List<MessageFormat.Block> blocks=MessageFormat.parse("# 中文标题\r\n- **重点**\r\n\r\n```c\r\n  x = 1;\r\n  // 保留缩进\r\n```\r\n继续说明");
        check(blocks.size()==3&&!blocks.get(0).code&&blocks.get(1).code&&!blocks.get(2).code,"text / code transitions");
        check(blocks.get(0).text.contains("# 中文标题")&&blocks.get(0).text.contains("**重点**"),"formatting source intact");
        check(blocks.get(1).text.equals("  x = 1;\n  // 保留缩进")&&blocks.get(1).language.equals("c"),"code indentation and language");
        blocks=MessageFormat.parse("```java\nif (ready) {\n");check(blocks.size()==1&&blocks.get(0).code&&blocks.get(0).text.equals("if (ready) {\n"),"unfinished streamed code stays code");
        blocks=MessageFormat.parse("````md\n```\nexample\n```\n````");check(blocks.size()==1&&blocks.get(0).text.equals("```\nexample\n```"),"long fences preserve nested fences");
        blocks=MessageFormat.parse("~~~txt\n<file>&密码\n~~~");check(blocks.size()==1&&blocks.get(0).text.equals("<file>&密码"),"plain literals are not interpreted as HTML");
        blocks=MessageFormat.parse("普通文字\n第二行");check(blocks.size()==1&&blocks.get(0).text.equals("普通文字\n第二行"),"plain text");
        check(MessageFormat.parse("").isEmpty(),"empty response");check(MessageFormat.size(1024).equals("1.0 KB")&&MessageFormat.size(1536).equals("1.5 KB")&&MessageFormat.size(1048576).equals("1.0 MB"),"readable sizes");
        check(MessageFormat.skillMessage("$documents:documents\n正文\n$pdf:pdf").equals("技能：Word 文档\n正文\n$pdf:pdf"),"Only the leading known skill marker is presented as a friendly label");
        for(String literal:new String[]{"普通文字","$unknown\n正文","示例 $documents:documents\n正文","$documents:documentsExtra\n正文"})check(MessageFormat.skillMessage(literal).equals(literal),"Literal or unknown markers stay unchanged");
        System.out.println("Chat presentation: UTF8, code blocks, partial streaming, nested fences, literal text, skill labels and file sizes passed.");
    }
}
