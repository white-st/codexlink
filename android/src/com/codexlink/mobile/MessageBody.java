package com.codexlink.mobile;

import android.content.*;
import android.graphics.*;
import android.text.*;
import android.text.style.*;
import android.view.*;
import android.widget.*;
import java.util.regex.*;

final class MessageBody {
    private static TextView text(Context context,ChatUi ui,String value){TextView view=new TextView(context);view.setText(value);view.setTextSize(16);view.setTextColor(ChatUi.INK);view.setLineSpacing(ui.dp(4),1);view.setTextIsSelectable(true);return view;}
    static void add(LinearLayout parent,String value,boolean formatted){
        Context context=parent.getContext();ChatUi ui=new ChatUi(context);
        if(!formatted){parent.addView(text(context,ui,value));return;}
        for(MessageFormat.Block block:MessageFormat.parse(value)){
            if(!block.code){
                TextView body=text(context,ui,"");body.setText(markup(block.text));LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.bottomMargin=ui.dp(8);parent.addView(body,layout);continue;
            }
            LinearLayout box=new LinearLayout(context);box.setOrientation(LinearLayout.VERTICAL);box.setBackground(ui.surface(0xffedf1ee,10));box.setPadding(ui.dp(12),ui.dp(4),ui.dp(12),ui.dp(12));
            LinearLayout heading=new LinearLayout(context);heading.setGravity(Gravity.CENTER_VERTICAL);TextView language=text(context,ui,block.language.isEmpty()?"代码":block.language);language.setTextSize(12);language.setTextColor(ChatUi.MUTED);heading.addView(language,new LinearLayout.LayoutParams(0,-2,1));
            heading.addView(ui.iconButton("copy","复制代码",()->copy(context,block.text)),new LinearLayout.LayoutParams(ui.dp(44),ui.dp(44)));box.addView(heading);
            HorizontalScrollView scroll=new HorizontalScrollView(context);TextView code=text(context,ui,block.text);code.setTypeface(Typeface.MONOSPACE);code.setTextSize(13);code.setHorizontallyScrolling(true);scroll.addView(code,new ViewGroup.LayoutParams(-2,-2));box.addView(scroll,new LinearLayout.LayoutParams(-1,-2));
            LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.topMargin=ui.dp(4);layout.bottomMargin=ui.dp(12);parent.addView(box,layout);
        }
    }
    private static CharSequence markup(String source){
        SpannableStringBuilder output=new SpannableStringBuilder();String[] lines=source.split("\n",-1);
        for(int i=0;i<lines.length;i++){
            String line=lines[i];int heading=0;Matcher marker=Pattern.compile("^(#{1,6})\\s+(.*)$").matcher(line);
            if(marker.matches()){heading=marker.group(1).length();line=marker.group(2);}
            boolean bullet=line.matches("^\\s*[-*+]\\s+.*");if(bullet)line=line.replaceFirst("^\\s*[-*+]\\s+","•  ");
            int start=output.length();Matcher inline=Pattern.compile("(`[^`\\n]+`|\\*\\*[^*\\n]+\\*\\*)").matcher(line);int last=0;
            while(inline.find()){output.append(line.substring(last,inline.start()));String token=inline.group();boolean code=token.startsWith("`");int at=output.length();output.append(token.substring(code?1:2,token.length()-(code?1:2)));int end=output.length();
                output.setSpan(code?new TypefaceSpan("monospace"):new StyleSpan(Typeface.BOLD),at,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                if(code){output.setSpan(new BackgroundColorSpan(0xffe7efe9),at,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);output.setSpan(new ForegroundColorSpan(ChatUi.GREEN),at,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);}last=inline.end();
            }output.append(line.substring(last));int end=output.length();
            if(heading>0&&end>start){output.setSpan(new StyleSpan(Typeface.BOLD),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);output.setSpan(new RelativeSizeSpan(heading<=2?1.18f:1.06f),start,end,Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);}
            if(i<lines.length-1)output.append('\n');
        }return output;
    }
    static void copy(Context context,String value){((android.content.ClipboardManager)context.getSystemService(Context.CLIPBOARD_SERVICE)).setPrimaryClip(ClipData.newPlainText("CodexLink",value));Toast.makeText(context,"已复制",Toast.LENGTH_SHORT).show();}
}
