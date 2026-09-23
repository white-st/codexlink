package com.codexlink.mobile;

import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.*;
import android.graphics.drawable.*;
import android.view.*;
import android.widget.*;

/** Shared native styling; no network, account or task state lives here. */
final class ChatUi {
    static final int GREEN=0xff18745b, INK=0xff202d27, MUTED=0xff6b7771, BG=0xfff4f6f5, LINE=0xffe4eae6, SOFT=0xffe6f3ec;
    final Context context;
    ChatUi(Context context){this.context=context;}
    int dp(float value){return (int)(context.getResources().getDisplayMetrics().density*value+.5f);}
    GradientDrawable surface(int color,int radius){GradientDrawable shape=new GradientDrawable();shape.setColor(color);shape.setCornerRadius(dp(radius));return shape;}
    GradientDrawable outline(int color,int radius){GradientDrawable shape=surface(color,radius);shape.setStroke(dp(1),LINE);return shape;}
    RippleDrawable touch(int color,int radius){return new RippleDrawable(ColorStateList.valueOf(0x1818745b),surface(color,radius),surface(Color.WHITE,radius));}
    RippleDrawable card(){return new RippleDrawable(ColorStateList.valueOf(0x1818745b),outline(Color.WHITE,18),surface(Color.WHITE,18));}
    void button(Button button,boolean primary){
        button.setAllCaps(false);button.setTextSize(14);button.setTypeface(null,Typeface.BOLD);
        button.setMinWidth(0);button.setMinimumWidth(0);button.setMinHeight(dp(48));button.setMinimumHeight(dp(48));
        button.setPadding(dp(16),dp(8),dp(16),dp(8));button.setElevation(0);button.setStateListAnimator(null);button.setBackgroundTintList(null);
        button.setBackground(touch(primary?GREEN:Color.WHITE,12));
        button.setTextColor(new ColorStateList(new int[][]{new int[]{-android.R.attr.state_enabled},new int[]{}},new int[]{primary?0xffc4d5cd:0xffa0aaa4,primary?Color.WHITE:GREEN}));
    }
    void input(EditText input){input.setBackground(outline(Color.WHITE,12));input.setPadding(dp(14),dp(12),dp(14),dp(12));input.setMinHeight(dp(52));input.setHintTextColor(0xff8b9690);}
    TextView icon(String kind,int color,int background,int size){
        TextView view=new TextView(context);view.setGravity(Gravity.CENTER);view.setBackground(surface(background,12));
        Glyph glyph=new Glyph(kind,color);glyph.setBounds(0,0,dp(size),dp(size));view.setCompoundDrawables(null,glyph,null,null);view.setPadding(0,dp(11),0,0);view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);return view;
    }
    ImageButton iconButton(String kind,String description,Runnable action){
        ImageButton view=new ImageButton(context);view.setImageDrawable(new Glyph(kind,GREEN));view.setScaleType(ImageView.ScaleType.FIT_CENTER);view.setPadding(dp(12),dp(12),dp(12),dp(12));view.setBackground(touch(Color.TRANSPARENT,14));view.setContentDescription(description);view.setTooltipText(description);view.setOnClickListener(v->action.run());return view;
    }
    View divider(){View view=new View(context);view.setBackgroundColor(LINE);view.setLayoutParams(new LinearLayout.LayoutParams(-1,dp(1)));return view;}
    static final class Glyph extends Drawable {
        final String kind;final Paint paint=new Paint(Paint.ANTI_ALIAS_FLAG);
        Glyph(String kind,int color){this.kind=kind;paint.setColor(color);paint.setStyle(Paint.Style.STROKE);paint.setStrokeWidth(1.7f);paint.setStrokeCap(Paint.Cap.ROUND);paint.setStrokeJoin(Paint.Join.ROUND);}
        private void path(Canvas canvas,float... xy){Path path=new Path();path.moveTo(xy[0],xy[1]);for(int i=2;i<xy.length;i+=2)path.lineTo(xy[i],xy[i+1]);canvas.drawPath(path,paint);}
        @Override public void draw(Canvas canvas){Rect bounds=getBounds();canvas.save();canvas.translate(bounds.left,bounds.top);canvas.scale(bounds.width()/24f,bounds.height()/24f);
            switch(kind){
                case "back":path(canvas,15,5,8,12,15,19);break;
                case "plus":path(canvas,12,5,12,19);path(canvas,5,12,19,12);break;
                case "phone":canvas.drawRoundRect(6,2,18,22,3,3,paint);path(canvas,10,18,14,18);break;
                case "computer":canvas.drawRoundRect(3,4,21,17,2,2,paint);path(canvas,8,21,16,21);path(canvas,12,17,12,21);break;
                case "folder":path(canvas,3,7,3,5,10,5,12,8,21,8,21,19,3,19,3,7);break;
                case "file":path(canvas,6,3,14,3,19,8,19,21,6,21,6,3);path(canvas,14,3,14,8,19,8);path(canvas,9,12,16,12);path(canvas,9,16,14,16);break;
                case "send":path(canvas,4,11,20,4,13,20,11,13,4,11);path(canvas,11,13,20,4);break;
                case "copy":canvas.drawRoundRect(8,7,20,21,2,2,paint);path(canvas,15,3,4,3,4,16);break;
                case "more":for(int i=5;i<=19;i+=7)canvas.drawCircle(i,12,.8f,paint);break;
                case "arrow":path(canvas,9,6,15,12,9,18);break;
                case "person":canvas.drawCircle(12,7,4,paint);canvas.drawArc(4,13,20,28,180,180,false,paint);break;
                case "lock":canvas.drawRoundRect(5,10,19,22,2,2,paint);canvas.drawArc(8,2,16,18,180,180,false,paint);path(canvas,12,15,12,18);break;
                case "attach":path(canvas,8,13,14,7);canvas.drawArc(9,2,21,14,210,280,false,paint);path(canvas,20,11,10,21);canvas.drawArc(2,12,12,22,40,230,false,paint);path(canvas,3,15,12,6);break;
                default:canvas.drawRoundRect(3,4,21,18,4,4,paint);path(canvas,8,18,5,22,5,17);path(canvas,8,9,16,9);path(canvas,8,13,13,13);
            }canvas.restore();
        }
        @Override public void setAlpha(int alpha){paint.setAlpha(alpha);}
        @Override public void setColorFilter(ColorFilter filter){paint.setColorFilter(filter);}
        @Override public int getOpacity(){return PixelFormat.TRANSLUCENT;}
        @Override public int getIntrinsicWidth(){return 24;}
        @Override public int getIntrinsicHeight(){return 24;}
    }
}
