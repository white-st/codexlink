package com.codexlink.mobile;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.*;
import android.text.InputFilter;
import android.text.InputType;
import android.text.TextWatcher;
import android.text.Editable;
import android.text.TextUtils;
import android.view.inputmethod.EditorInfo;
import android.view.*;
import android.widget.*;
import org.json.*;
import java.io.*;
import java.net.URLEncoder;
import java.util.*;
import java.util.concurrent.*;

public final class MainActivity extends Activity {
    private static final int GREEN = ChatUi.GREEN, INK = ChatUi.INK, MUTED = ChatUi.MUTED, BG = ChatUi.BG;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final ExecutorService uploadWorker = Executors.newSingleThreadExecutor();
    private final AttachmentUploads<JSONObject> uploads = new AttachmentUploads<>();
    private final Set<String> uncertain = new HashSet<>();
    private AppCookies cookies;
    private ApiClient api;
    private UpdateChecker updates;
    private EditText loginName, loginPassword;
    private ChatUi ui;
    private JSONObject user, snapshot = new JSONObject();
    private String projectId = "", taskId = "", historySignature = "", questionSignature = "", listSignature = "";
    private LinearLayout root, page, messageList, questions;
    private ScrollView messageScroll;
    private TextView notice, uploadNotice, taskState, composerHint;
    private TextView profileName, profileLevel, profileConnection;
    private EditText composer;
    private Button send, stop, skillPicker;
    private LinearLayout listBody;
    private ScrollView listScroll;
    private ProgressBar progress;
    private String searchQuery = "", listContext = "", accountHint = "";
    private boolean quietRequest;
    private boolean showingProfile;
    private boolean loading, foreground, destroyed, returningFromVerification;
    private int epoch, openDialogs;
    private String exportTask, exportName, exportUser;
    private String importTask, importUser, attachmentTask = "";
    private boolean alternateAttachmentPicker;
    private List<JSONObject> attachments = new ArrayList<>();
    private LinearLayout attachmentRows;
    private ImageButton attach;
    private final Runnable poll = new Runnable() { public void run() {
        if (!foreground || destroyed) return;
        updates.tick();
        if (user != null && !loading && exportTask == null && importTask == null && openDialogs == 0) refresh(false, true);
        main.postDelayed(this, 4500);
    }};

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        ui = new ChatUi(this);
        cookies = new AppCookies(); api = new ApiClient(ApiClient.ORIGIN, cookies);
        updates = new UpdateChecker(this,api,this::canPromptUpdates,this::showDialog,this::toast);
        root = new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); root.setBackgroundColor(BG);
        setContentView(root); Screen.insets(this, root);
        if (Build.VERSION.SDK_INT >= 33) getOnBackInvokedDispatcher().registerOnBackInvokedCallback(0, this::goBack);
        showLogin(); checkAuth();
    }
    @Override protected void onResume() {
        super.onResume(); foreground = true; main.removeCallbacks(poll); main.postDelayed(poll, 4500);
        if (returningFromVerification && !loading) { returningFromVerification = false; checkAuth(); }
    }
    @Override protected void onPause() { foreground = false; main.removeCallbacks(poll); super.onPause(); }
    @Override public void onConfigurationChanged(android.content.res.Configuration configuration){super.onConfigurationChanged(configuration);if(composer!=null)composer.setMaxLines(configuration.orientation==android.content.res.Configuration.ORIENTATION_LANDSCAPE?2:5);if(listBody!=null)renderRows();}
    @Override protected void onDestroy() { destroyed = true; epoch++; uploads.account("");main.removeCallbacksAndMessages(null); updates.close(); worker.shutdownNow();uploadWorker.shutdownNow(); super.onDestroy(); }
    private boolean canPromptUpdates(){return foreground&&!destroyed&&!loading&&uploads.active()==null&&!uploads.hasDrafts()&&openDialogs==0&&importTask==null&&exportTask==null&&!hasDraft()&&(loginName==null||loginName.length()==0)&&(loginPassword==null||loginPassword.length()==0);}
    @Override public void onBackPressed() { goBack(); }
    private void goBack() {
        if (loading&&!quietRequest) { toast("操作处理中，请稍候"); return; }
        if(showingProfile){switchPage("projects");return;}
        if (!taskId.isEmpty()) {
            leaveTask();
        } else if (!projectId.isEmpty()) { epoch++; projectId = "";searchQuery=""; renderLists(); }
        else moveTaskToBack(true);
    }
    private boolean hasDraft(){return composer!=null&&!composer.getText().toString().trim().isEmpty()||!attachments.isEmpty();}
    private void saveDraft(){if(user!=null&&composer!=null&&!attachmentTask.isEmpty())uploads.draft(attachmentTask).text=composer.getText().toString();}
    private void clearAttachments(){attachments=new ArrayList<>();attachmentTask="";importTask=null;importUser=null;}
    private void leaveTask() { saveDraft();epoch++; taskId = ""; composer = null; searchQuery = "";clearAttachments(); renderLists(); }
    private int dp(int value) { return (int)(getResources().getDisplayMetrics().density * value + .5f); }
    private LinearLayout column() { LinearLayout box = new LinearLayout(this); box.setOrientation(LinearLayout.VERTICAL); return box; }
    private LinearLayout row() { LinearLayout box = new LinearLayout(this); box.setGravity(Gravity.CENTER_VERTICAL); return box; }
    private TextView text(String value, int size, int color) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size); view.setTextColor(color); view.setPadding(0,dp(4),0,dp(4)); view.setIncludeFontPadding(false); return view;
    }
    private void label(LinearLayout box, String value) { box.addView(text(value, 14, MUTED)); }
    private GradientDrawable rounded(int color) { GradientDrawable bg = new GradientDrawable(); bg.setColor(color); bg.setCornerRadius(dp(16)); return bg; }
    private Button button(String title, Runnable action) {
        Button view = new Button(this); view.setText(title); ui.button(view,false);
        view.setOnClickListener(v -> { if (!loading) action.run(); else toast("操作处理中，请稍候"); }); return view;
    }
    private Button primary(String title,Runnable action) { Button view=button(title,action);ui.button(view,true);return view; }
    private ImageButton iconAction(String kind,String title,Runnable action){return ui.iconButton(kind,title,()->{if(!loading||kind.equals("back")&&quietRequest)action.run();else toast("正在更新，请稍候");});}
    private void space(LinearLayout box,int height){View view=new View(this);box.addView(view,new LinearLayout.LayoutParams(1,dp(height)));}
    private TextView caption(String value){TextView view=text(value,12,MUTED);view.setLetterSpacing(.04f);return view;}
    private EditText field(String hint, boolean secret, int max) {
        EditText view = new EditText(this); view.setHint(hint); view.setTextSize(16); view.setTextColor(INK);
        view.setSingleLine(true); view.setFilters(new InputFilter[]{new InputFilter.LengthFilter(max)}); view.setSaveEnabled(false);
        view.setInputType(secret ? InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD : InputType.TYPE_CLASS_TEXT);
        ui.input(view);
        return view;
    }
    private void scaffold(String title, String subtitle, boolean back) {
        scaffold(title,subtitle,back,false);
    }
    private void scaffold(String title, String subtitle, boolean back, boolean compact) {
        root.removeAllViews(); composer = null; send = null; stop = null; listBody=null; listScroll=null; taskState=null;composerHint=null;
        profileName=null;profileLevel=null;profileConnection=null;
        loginName=null;loginPassword=null;
        attachmentRows=null;attach=null;skillPicker=null;
        LinearLayout header = row(); header.setPadding(dp(8), dp(compact?0:8), dp(8), dp(compact?0:8));header.setBackgroundColor(Color.WHITE);
        if(compact)header.setMinimumHeight(dp(48));
        if (back) header.addView(iconAction("back","返回",this::goBack),new LinearLayout.LayoutParams(dp(48),dp(48)));
        else {TextView brand=text("C↗",compact?14:19,Color.WHITE);brand.setGravity(Gravity.CENTER);brand.setTypeface(null,Typeface.BOLD);brand.setBackground(ui.surface(GREEN,compact?9:13));LinearLayout.LayoutParams badge=new LinearLayout.LayoutParams(dp(compact?28:42),dp(compact?28:42));badge.leftMargin=dp(8);badge.rightMargin=dp(compact?10:12);header.addView(brand,badge);}
        LinearLayout heading = column(); TextView name = text(title, compact?17:19, INK); name.setTypeface(null, Typeface.BOLD); name.setMaxLines(1);name.setEllipsize(TextUtils.TruncateAt.END);heading.addView(name);
        if (!subtitle.isEmpty()) {TextView sub=text(subtitle,12,MUTED);sub.setMaxLines(1);sub.setEllipsize(TextUtils.TruncateAt.END);heading.addView(sub);}
        header.addView(heading, new LinearLayout.LayoutParams(0, -2, 1));
        if(user!=null&&!showingProfile){if(!taskId.isEmpty())header.addView(iconAction("file","项目文件",this::showFiles),new LinearLayout.LayoutParams(dp(48),dp(48)));
            else if(projectId.isEmpty()||project()!=null&&project().optBoolean("owned"))header.addView(iconAction("plus",projectId.isEmpty()?"新建项目":"新建任务",()->{if(projectId.isEmpty())createProjectDialog();else createTaskDialog();}),new LinearLayout.LayoutParams(dp(48),dp(48)));}
        if(!showingProfile){ImageButton more=iconAction("more","更多操作",()->{});more.setOnClickListener(v->showMenu(more));header.addView(more,new LinearLayout.LayoutParams(dp(48),dp(48)));}root.addView(header);
        progress=new ProgressBar(this,null,android.R.attr.progressBarStyleHorizontal);progress.setIndeterminate(true);progress.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(GREEN));progress.setVisibility(View.INVISIBLE);root.addView(progress,new LinearLayout.LayoutParams(-1,dp(2)));
        notice = text("", 13, MUTED); notice.setPadding(dp(18), dp(8), dp(18), dp(8));notice.setBackgroundColor(0xfffff2d7);notice.setVisibility(View.GONE); root.addView(notice);
        uploadNotice=text("",13,GREEN);uploadNotice.setPadding(dp(18),dp(9),dp(18),dp(9));uploadNotice.setBackground(ui.touch(ChatUi.SOFT,0));uploadNotice.setOnClickListener(v->{if(loading&&!quietRequest)return;AttachmentUploads.Job<JSONObject> job=uploads.notice();if(job!=null&&openUploadTask(job)&&job.complete&&job.error!=null)showUploadFailure(job);});root.addView(uploadNotice);renderUploadNotice();
        page = column(); root.addView(page, new LinearLayout.LayoutParams(-1, 0, 1));
    }
    private void showMenu(View anchor){
        if(loading){toast("正在更新，请稍候");return;}
        PopupMenu menu=new PopupMenu(this,anchor);
        if(user!=null)menu.getMenu().add("刷新状态").setOnMenuItemClickListener(item->{if(!loading)refresh(!taskId.isEmpty());return true;});
        if(!taskId.isEmpty()&&task()!=null&&task().optBoolean("canExecute")){
            String control=task().optString("control","mobile");
            if(control.equals("desktop")||control.equals("release-pending"))menu.getMenu().add("恢复工作台操作").setOnMenuItemClickListener(item->{if(!loading)restoreWorkbenchDialog();return true;});
        }
        if(!taskId.isEmpty()&&task()!=null&&task().optBoolean("canExecute")&&!task().isNull("activeTurn"))menu.getMenu().add("停止当前执行").setOnMenuItemClickListener(item->{if(!loading)showDialog(new AlertDialog.Builder(this).setTitle("停止当前执行？").setMessage("已经生成的内容会保留。").setNegativeButton("继续执行",null).setPositiveButton("停止",(d,w)->taskAction("stop",new JSONObject())).create());return true;});
        if(taskId.isEmpty()&&!projectId.isEmpty()&&project()!=null&&(project().optBoolean("owned")||"admin".equals(user.optString("role"))))menu.getMenu().add("项目设置").setOnMenuItemClickListener(item->{if(!loading)projectDialog();return true;});
        if(taskId.isEmpty()&&project()!=null&&project().optBoolean("owned"))menu.getMenu().add("删除项目").setOnMenuItemClickListener(item->{if(!loading)removeProjectDialog(project());return true;});
        menu.getMenu().add("连接与账号").setOnMenuItemClickListener(item->{if(!loading)connectionDialog();return true;});
        menu.getMenu().add("检查更新").setOnMenuItemClickListener(item->{updates.check(true);return true;});openDialogs++;menu.setOnDismissListener(value->openDialogs--);menu.show();
    }
    private void showDialog(AlertDialog dialog){openDialogs++;dialog.setOnDismissListener(value->openDialogs--);dialog.show();}
    private boolean mobileControl(){return task()!=null&&task().optString("control","mobile").equals("mobile");}
    private void restoreWorkbenchDialog(){
        JSONObject selected=task();if(selected==null||!selected.optBoolean("canExecute"))return;
        String control=selected.optString("control","mobile");if(!control.equals("desktop")&&!control.equals("release-pending"))return;
        if(uploads.uploading(taskId)){toast("请等待附件上传完成");return;}
        if(selected.optBoolean("busy")||uncertain.contains(taskId)||selected.optString("control").equals("changing")){toast("请先完成当前执行，或刷新核对任务状态");return;}
        String selectedId=taskId,account=user.optString("id");
        String message="这条任务曾交给电脑 Codex。若电脑仍占用，请等电脑任务完成后，从右下角托盘退出 Codex，再回来恢复。\n\n恢复后，手机 App 和电脑网页工作台都可以继续处理这条任务，对话、文件与本次草稿保留。";
        showDialog(new AlertDialog.Builder(this).setTitle("恢复工作台操作？").setMessage(message).setNegativeButton("取消",null).setPositiveButton("恢复",(d,w)->{
            if(user==null||!account.equals(user.optString("id"))||!selectedId.equals(taskId)||uploads.uploading(selectedId))return;
            saveDraft();run(()->object(api.json("/api/tasks/"+selectedId+"/transfer",json("target","mobile").toString())),value->{
                JSONObject current=task();if(current!=null)put(current,"control",value.optJSONObject("task").optString("control"));
                uncertain.remove(selectedId);updateControls();refresh(false);
                toast("已恢复工作台操作，可以继续发送");
            },true,selectedId);
        }).create());
    }
    private void showLogin() {
        uploads.account("");
        clearAttachments();
        showingProfile=false;
        scaffold("CodexLink", "你的随身工作台", false);
        ScrollView scroll = new ScrollView(this);scroll.setFillViewport(true); LinearLayout form = column(); form.setPadding(dp(28),dp(36),dp(28),dp(24)); scroll.addView(form); page.addView(scroll,new LinearLayout.LayoutParams(-1,-1));
        TextView title = text("发一句需求，\n让电脑开始工作。", 30, INK); title.setTypeface(null, Typeface.BOLD);title.setLineSpacing(dp(6),1); form.addView(title);
        space(form,10);label(form, "像聊天一样使用 Codex，\n随时查看进度，取回你的文件。");space(form,28);
        label(form,"账号");EditText username = field("输入已有账号", false, 40), password = field("输入密码", true, 128);
        loginName=username;loginPassword=password;
        username.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        username.setText(accountHint);
        username.setAutofillHints(View.AUTOFILL_HINT_USERNAME); password.setAutofillHints(View.AUTOFILL_HINT_PASSWORD);
        username.setImeOptions(EditorInfo.IME_ACTION_NEXT);password.setImeOptions(EditorInfo.IME_ACTION_DONE);
        form.addView(username);space(form,14);label(form,"密码");form.addView(password);space(form,22);
        Button login=primary("登录工作台", () -> {
            String account = username.getText().toString().trim(), secret = password.getText().toString();
            if (account.isEmpty() || secret.isEmpty()) { toast("请填写账号和密码"); return; }
            accountHint=account;
            password.setText("");
            run(() -> object(api.json("/api/auth/login", json("username", account, "password", secret).toString())), value -> {
                user = value.optJSONObject("user");snapshot=new JSONObject(); projectId = ""; taskId = "";searchQuery=""; uncertain.clear(); renderLists(); refresh(false);
            }, false, null);
        });form.addView(login,new LinearLayout.LayoutParams(-1,dp(52)));
        password.setOnEditorActionListener((v,action,event)->{if(action==EditorInfo.IME_ACTION_DONE){login.performClick();return true;}return false;});
        space(form,16);TextView note=caption("使用电脑端的同一账号 · App 不保存密码");note.setGravity(Gravity.CENTER);form.addView(note);
        space(form,8);form.addView(button("连接遇到问题？",this::connectionDialog));
    }
    private void checkAuth() {
        run(() -> object(api.json("/api/auth", null)), value -> {
            JSONObject next = value.optJSONObject("user");
            boolean sameAccount = user != null && next != null && user.optString("id").equals(next.optString("id"));
            user = next;
            if (user == null) { snapshot = new JSONObject(); projectId = ""; taskId = ""; showLogin(); hint(value.optBoolean("setupRequired") ? "请先在电脑上完成账号设置" : "连接正常，请登录"); }
            else {
                if (!sameAccount) { snapshot = new JSONObject(); projectId = ""; taskId = "";searchQuery=""; uncertain.clear(); }
                // Returning from tunnel verification must preserve an unsent native draft.
                if (taskId.isEmpty()) renderLists();
                refresh(false);
            }
        }, false, null);
    }
    private void connectionDialog() {
        String message = (user==null?"尚未登录":"当前账号："+user.optString("username")+" · 等级 "+user.optInt("level"))+"\n\n当前连接：\n" + ApiClient.ORIGIN + "\n\n电脑和工作台服务需要保持运行。如果出现 DDNSTO 验证，完成后返回 App。\n\n版本 "+UpdatePackage.version(this)+" · 安卓测试版";
        AlertDialog.Builder dialog = new AlertDialog.Builder(this).setTitle("连接与账号").setMessage(message)
            .setPositiveButton("连接验证", (d,w) -> { returningFromVerification = true; startActivity(new Intent(this, VerificationActivity.class)); })
            .setNegativeButton("关闭", null);
        if (user != null&&!showingProfile) dialog.setNeutralButton("退出账号", (d,w) -> confirmLogout());
        showDialog(dialog.create());
    }
    private void clearAccount() {
        uploads.account("");
        clearAttachments();
        epoch++; user = null; snapshot = new JSONObject(); projectId = ""; taskId = "";searchQuery=""; uncertain.clear(); exportTask = null; exportName = null; exportUser = null;
        showingProfile=false;
    }
    private void logout() {
        clearAccount();
        showLogin();
        run(() -> { try { api.json("/api/auth/logout", "{}"); } catch (IOException ignored) {} cookies.clearSession(); return new JSONObject(); }, value -> hint("已退出账号"), false, null);
    }
    private JSONArray array(JSONObject value, String key) { JSONArray data = value.optJSONArray(key); return data == null ? new JSONArray() : data; }
    private JSONObject find(JSONArray values, String id) { for (int i=0;i<values.length();i++) { JSONObject value = values.optJSONObject(i); if (value != null && id.equals(value.optString("id"))) return value; } return null; }
    private JSONObject project() { return find(array(snapshot,"projects"), projectId); }
    private JSONObject task() { return find(array(snapshot,"tasks"), taskId); }
    private String privacy(JSONObject item) { return (item.optBoolean("shared") ? "共享 · 等级 " + item.optInt("level") : "私有 · 仅本人可见") + (item.optBoolean("owned") ? "" : " · 只读"); }
    private String status(JSONObject item) {
        String control=item.optString("control","mobile");
        if(control.equals("desktop"))return "待恢复工作台操作 · 只读";
        if(control.equals("changing"))return "正在交接";
        if(control.equals("release-pending"))return "待恢复工作台操作";
        String value = item.optString("status");
        if ("unknown".equals(value)) return "结果待核实";
        if ("waiting-input".equals(value) || "waiting".equals(value)) return "等待你的回答";
        if (item.optBoolean("busy")) return "正在执行";
        if ("completed".equals(value)) return "已完成";
        if ("failed".equals(value)) return "执行失败";
        if ("interrupted".equals(value)) return "已停止";
        return "可以继续";
    }
    private void renderLists() {
        if (user == null) { showLogin(); return; }
        uploads.account(user.optString("id"));
        if(showingProfile){renderProfile();return;}
        JSONObject selected = project();
        if (!projectId.isEmpty() && selected == null) { projectId = ""; taskId = ""; }
        scaffold(selected==null?"项目":selected.optString("name"),selected==null?"":privacy(selected),selected!=null,selected==null);
        LinearLayout searchBox=column();searchBox.setPadding(dp(16),dp(selected==null?8:10),dp(16),dp(selected==null?6:12));EditText search=field(selected==null?"搜索项目":"搜索这个项目中的任务",false,100);search.setTextSize(14);search.setMinHeight(dp(44));search.setText(searchQuery);search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);searchBox.addView(search);page.addView(searchBox);
        listScroll=new ScrollView(this);listScroll.setFillViewport(true);listBody=column();listBody.setPadding(dp(16),0,dp(16),dp(16));listScroll.addView(listBody);page.addView(listScroll,new LinearLayout.LayoutParams(-1,0,1));
        listContext=projectId;
        search.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){searchQuery=s.toString();renderRows();}public void afterTextChanged(Editable s){}});
        if(selected==null)addNavigation();
        renderRows();hint(connectionText());
    }
    private void addNavigation(){
        LinearLayout navigation=row();navigation.setPadding(dp(12),dp(6),dp(12),dp(6));navigation.setBackgroundColor(Color.WHITE);
        navigation.addView(navItem("folder","项目","projects"),new LinearLayout.LayoutParams(0,dp(62),1));navigation.addView(navItem("person","我的","profile"),new LinearLayout.LayoutParams(0,dp(62),1));root.addView(ui.divider());root.addView(navigation);
    }
    private View navItem(String icon,String title,String target){
        boolean selected=showingProfile?target.equals("profile"):target.equals("projects");LinearLayout item=column();item.setGravity(Gravity.CENTER);item.setBackground(ui.touch(selected?ChatUi.SOFT:Color.WHITE,14));
        ImageView image=new ImageView(this);image.setImageDrawable(new ChatUi.Glyph(icon,selected?GREEN:MUTED));item.addView(image,new LinearLayout.LayoutParams(dp(22),dp(22)));TextView label=text(title,12,selected?GREEN:MUTED);label.setGravity(Gravity.CENTER);label.setTypeface(null,selected?Typeface.BOLD:Typeface.NORMAL);item.addView(label);item.setContentDescription(title);item.setSelected(selected);item.setFocusable(true);item.setOnClickListener(v->{if((!loading||quietRequest)&&!selected)switchPage(target);});return item;
    }
    private List<JSONObject> sorted(JSONArray data){List<JSONObject> values=new ArrayList<>();for(int i=0;i<data.length();i++)if(data.optJSONObject(i)!=null)values.add(data.optJSONObject(i));values.sort((a,b)->b.optString("createdAt").compareTo(a.optString("createdAt")));return values;}
    private boolean matches(JSONObject item){String query=searchQuery.trim().toLowerCase(Locale.ROOT);return query.isEmpty()||(item.optString("name")+" "+item.optString("projectName")).toLowerCase(Locale.ROOT).contains(query);}
    private String dateLabel(JSONObject item){try{java.time.ZonedDateTime date=java.time.Instant.parse(item.optString("createdAt")).atZone(java.time.ZoneId.systemDefault());return date.toLocalDate().equals(java.time.LocalDate.now())?date.format(java.time.format.DateTimeFormatter.ofPattern("HH:mm")):date.format(java.time.format.DateTimeFormatter.ofPattern("MM-dd"));}catch(Exception ignored){return "";}}
    private void section(String title){TextView label=caption(title);label.setPadding(dp(4),dp(8),dp(4),dp(8));listBody.addView(label);}
    private void renderRows(){
        if(listBody==null)return;int scrollY=listScroll.getScrollY();listBody.removeAllViews();boolean home=projectId.isEmpty();int count=0;
        if(home){
            List<JSONObject> projects=new ArrayList<>();for(JSONObject item:sorted(array(snapshot,"projects")))if("mobile".equals(item.optString("source"))&&matches(item))projects.add(item);
            if(!projects.isEmpty()){section("全部项目 · "+projects.size());addCardGrid(projects,true);count+=projects.size();}
        }else{List<JSONObject> tasks=new ArrayList<>();for(JSONObject item:sorted(array(snapshot,"tasks")))if(projectId.equals(item.optString("projectId"))&&matches(item))tasks.add(item);addCardGrid(tasks,false);count=tasks.size();}
        if(count==0){LinearLayout empty=column();empty.setGravity(Gravity.CENTER);empty.setPadding(dp(22),dp(48),dp(22),dp(32));TextView mark=text(!searchQuery.trim().isEmpty()?"没有找到结果":"开始一段新对话",22,INK);mark.setTypeface(null,Typeface.BOLD);mark.setGravity(Gravity.CENTER);empty.addView(mark);
            String message=!snapshot.has("projects")?"正在载入工作台…":!searchQuery.trim().isEmpty()?(home?"没有找到相关项目，换个关键词试试。":"没有找到相关任务，换个关键词试试。"):home?"先创建一个项目，把相关需求和文件放在一起。":"给任务起个名字，然后告诉 Codex 你想完成什么。";
            TextView detail=text(message,14,MUTED);detail.setGravity(Gravity.CENTER);empty.addView(detail);space(empty,20);
            if(snapshot.has("projects")&&searchQuery.trim().isEmpty()&&(home||project()!=null&&project().optBoolean("owned")))empty.addView(primary(home?"新建项目":"新建任务",home?this::createProjectDialog:this::createTaskDialog));listBody.addView(empty);
        }
        listSignature=snapshot.toString();ScrollView currentScroll=listScroll;currentScroll.post(()->{if(listScroll==currentScroll)currentScroll.scrollTo(0,scrollY);});
    }
    private void addCardGrid(List<JSONObject> items,boolean isProject){
        android.content.res.Configuration config=getResources().getConfiguration();
        int minimumWidth=Math.round(144*Math.max(1f,config.fontScale));
        int columns=Math.max(1,Math.min(3,(config.screenWidthDp-32+12)/(minimumWidth+12)));
        for(int start=0;start<items.size();start+=columns){
            LinearLayout line=row();line.setGravity(Gravity.TOP);line.setBaselineAligned(false);
            for(int column=0;column<columns;column++){
                View card=start+column<items.size()?itemCard(items.get(start+column),isProject):new View(this);
                LinearLayout.LayoutParams cell=new LinearLayout.LayoutParams(0,-2,1);if(column>0)cell.leftMargin=dp(12);line.addView(card,cell);
            }
            LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.bottomMargin=dp(12);listBody.addView(line,layout);
        }
    }
    private View itemCard(JSONObject item,boolean isProject){
        LinearLayout card=column();card.setPadding(dp(14),dp(14),dp(14),dp(14));card.setMinimumHeight(dp(190));card.setBackground(ui.card());card.setFocusable(true);
        LinearLayout top=row();TextView avatar=ui.icon(isProject?"folder":"message",GREEN,isProject?0xffedf1ee:ChatUi.SOFT,20);avatar.setPadding(0,dp(8),0,0);top.addView(avatar,new LinearLayout.LayoutParams(dp(36),dp(36)));
        top.addView(new View(this),new LinearLayout.LayoutParams(0,1,1));TextView time=text(dateLabel(item),11,MUTED);time.setPadding(dp(4),0,0,0);top.addView(time);card.addView(top);space(card,10);
        TextView title=text(item.optString("name"),16,INK);title.setTypeface(null,Typeface.BOLD);title.setMinLines(2);title.setMaxLines(2);title.setEllipsize(TextUtils.TruncateAt.END);title.setLineSpacing(dp(2),1);card.addView(title);
        int total=0;if(isProject)for(JSONObject task:sorted(array(snapshot,"tasks")))if(item.optString("id").equals(task.optString("projectId")))total++;
        String detail=isProject?(total+" 个任务 · "+privacy(item)):(projectId.isEmpty()?item.optString("projectName")+" · ":"")+status(item)+(item.optBoolean("canExecute")?"":" · 只读");
        TextView sub=text(isProject?total+" 个任务":projectId.isEmpty()?item.optString("projectName"):"",12,MUTED);sub.setMinLines(1);sub.setMaxLines(1);sub.setEllipsize(TextUtils.TruncateAt.END);card.addView(sub);space(card,8);
        String state=isProject?privacy(item):status(item)+(item.optBoolean("canExecute")?"":" · 只读");
        int stateColor=!isProject&&item.optBoolean("busy")?GREEN:!isProject&&("unknown".equals(item.optString("status"))||"waiting-input".equals(item.optString("status"))||"waiting".equals(item.optString("status")))?0xff976018:!isProject&&"failed".equals(item.optString("status"))?0xffa44035:MUTED;
        TextView footer=text(state,11,stateColor);footer.setPadding(dp(8),dp(6),dp(8),dp(6));footer.setMinLines(2);footer.setMaxLines(2);footer.setEllipsize(TextUtils.TruncateAt.END);footer.setBackground(ui.surface(!isProject&&item.optBoolean("busy")?ChatUi.SOFT:BG,8));card.addView(footer);
        card.setContentDescription(item.optString("name")+"，"+detail);card.setOnClickListener(v->{if(loading&&!quietRequest)return;saveDraft();epoch++;searchQuery="";projectId=isProject?item.optString("id"):item.optString("projectId");if(isProject)renderLists();else{taskId=item.optString("id");showChat();refresh(false);}});
        if(isProject&&item.optBoolean("owned")){card.setTooltipText("长按删除项目");card.setOnLongClickListener(v->{if(!loading)removeProjectDialog(item);else toast("正在更新，请稍候");return true;});}
        return card;
    }
    private void switchPage(String value) { saveDraft();epoch++;clearAttachments(); showingProfile=value.equals("profile");projectId="";taskId="";searchQuery="";renderLists(); }
    private void renderProfile(){
        if(user==null){showLogin();return;}
        scaffold("我的","",false,true);
        ScrollView scroll=new ScrollView(this);LinearLayout content=column();content.setPadding(dp(16),dp(18),dp(16),dp(24));scroll.addView(content);page.addView(scroll,new LinearLayout.LayoutParams(-1,-1));
        LinearLayout identity=row();identity.setPadding(dp(18),dp(20),dp(18),dp(20));identity.setBackground(ui.outline(Color.WHITE,18));TextView avatar=ui.icon("person",GREEN,ChatUi.SOFT,24);identity.addView(avatar,new LinearLayout.LayoutParams(dp(48),dp(48)));
        LinearLayout details=column();profileName=text("",20,INK);profileName.setTypeface(null,Typeface.BOLD);profileName.setMaxLines(2);profileName.setEllipsize(TextUtils.TruncateAt.END);details.addView(profileName);profileLevel=text("",13,MUTED);details.addView(profileLevel);LinearLayout.LayoutParams identityText=new LinearLayout.LayoutParams(0,-2,1);identityText.leftMargin=dp(14);identity.addView(details,identityText);content.addView(identity);
        space(content,20);LinearLayout settings=column();settings.setBackground(ui.outline(Color.WHITE,18));
        settings.addView(profileAction("lock","修改密码","至少 6 位，修改后重新登录",this::changePasswordDialog));settings.addView(ui.divider());
        settings.addView(profileAction("computer","连接信息","查看电脑连接与访问地址",this::connectionDialog));content.addView(settings);
        settings.addView(ui.divider());settings.addView(profileAction("phone","检查更新","当前版本 "+UpdatePackage.version(this),()->updates.check(true)));
        space(content,10);profileConnection=text("",12,MUTED);profileConnection.setGravity(Gravity.CENTER);content.addView(profileConnection);
        space(content,20);Button signOut=button("退出登录",this::confirmLogout);signOut.setTextColor(0xffa44035);content.addView(signOut,new LinearLayout.LayoutParams(-1,dp(48)));
        space(content,16);TextView version=caption("CodexLink "+UpdatePackage.version(this));version.setGravity(Gravity.CENTER);content.addView(version);addNavigation();updateProfile();hint(connectionText());
    }
    private View profileAction(String icon,String title,String subtitle,Runnable action){
        LinearLayout item=row();item.setPadding(dp(16),dp(14),dp(12),dp(14));item.setBackground(ui.touch(Color.TRANSPARENT,16));item.setMinimumHeight(dp(76));item.setFocusable(true);item.setContentDescription(title+"，"+subtitle);item.setOnClickListener(v->{if(!loading)action.run();else toast("正在更新，请稍候");});
        ImageView image=new ImageView(this);image.setImageDrawable(new ChatUi.Glyph(icon,GREEN));item.addView(image,new LinearLayout.LayoutParams(dp(24),dp(24)));
        LinearLayout labels=column();TextView heading=text(title,16,INK);heading.setTypeface(null,Typeface.BOLD);labels.addView(heading);labels.addView(text(subtitle,12,MUTED));LinearLayout.LayoutParams labelLayout=new LinearLayout.LayoutParams(0,-2,1);labelLayout.leftMargin=dp(14);item.addView(labels,labelLayout);
        ImageView arrow=new ImageView(this);arrow.setImageDrawable(new ChatUi.Glyph("arrow",MUTED));item.addView(arrow,new LinearLayout.LayoutParams(dp(18),dp(18)));return item;
    }
    private void updateProfile(){
        if(!showingProfile||user==null||profileName==null)return;
        profileName.setText(user.optString("username"));profileLevel.setText(("admin".equals(user.optString("role"))?"管理员":"普通用户")+" · 等级 "+user.optInt("level"));
        profileConnection.setText(!snapshot.has("connected")?"正在读取连接状态…":snapshot.optBoolean("connected")&&snapshot.optBoolean("signedIn")?"已连接电脑":connectionText());
    }
    private void confirmLogout(){
        String message="退出后可以使用其他账号登录。";
        message+="未发送的文字和附件选择会从 App 清除，已上传文件仍保留在项目中。";
        if(uploads.active()!=null)message+="正在上传的附件可能中断，请稍后在原项目核对文件。";
        showDialog(new AlertDialog.Builder(this).setTitle("退出当前账号？").setMessage(message).setNegativeButton("取消",null).setPositiveButton("退出登录",(d,w)->logout()).create());
    }
    private void changePasswordDialog(){
        if(user==null)return;final String account=user.optString("username");
        LinearLayout fields=form();fields.setPadding(dp(24),dp(8),dp(24),dp(16));ScrollView scroll=new ScrollView(this);scroll.addView(fields);
        EditText current=field("输入当前密码",true,128),next=field("至少 6 位",true,128),confirm=field("再次输入新密码",true,128);
        label(fields,"当前密码");fields.addView(current);space(fields,10);label(fields,"新密码");fields.addView(next);space(fields,10);label(fields,"确认新密码");fields.addView(confirm);space(fields,10);label(fields,"修改后所有设备需要重新登录。");
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("修改密码").setView(scroll).setNegativeButton("取消",null).setPositiveButton("保存并重新登录",null).create();showDialog(dialog);
        dialog.setOnDismissListener(d->{openDialogs--;current.setText("");next.setText("");confirm.setText("");});
        dialog.getButton(-1).setOnClickListener(v->{if(loading)return;String old=current.getText().toString(),updated=next.getText().toString();
            if(old.isEmpty()){current.setError("请填写当前密码");return;}if(updated.length()<6){next.setError("新密码至少 6 位");return;}if(!updated.equals(confirm.getText().toString())){confirm.setError("两次新密码不一致");return;}
            dialog.dismiss();run(()->object(api.json("/api/auth/password",json("currentPassword",old,"password",updated).toString())),result->{clearAccount();accountHint=account;showLogin();hint("密码已修改，请使用新密码重新登录");},true,null);
        });
    }
    private LinearLayout form() { LinearLayout form=column(); form.setPadding(dp(24),dp(8),dp(24),dp(8)); return form; }
    private Spinner levels(int selected) { Spinner spinner=new Spinner(this); String[] values=new String[10]; for(int i=0;i<10;i++) values[i]="等级 " + i; spinner.setAdapter(new ArrayAdapter<String>(this,android.R.layout.simple_spinner_dropdown_item,values)); spinner.setSelection(selected); return spinner; }
    private void createProjectDialog() {
        LinearLayout form=form(); EditText name=field("项目名称",false,80); Spinner level=levels(0); form.addView(name); label(form,"预设项目等级"); form.addView(level); label(form,"新项目默认私有。文件自动按创建日期存入电脑的手机工作目录。");
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("新建项目").setView(form).setNegativeButton("取消",null).setPositiveButton("创建",null).create(); showDialog(dialog);
        dialog.getButton(-1).setOnClickListener(v->{ String title=name.getText().toString().trim(); if(title.isEmpty()){name.setError("请填写名称");return;} if(loading)return; dialog.dismiss();
            run(()->object(api.json("/api/projects",json("name",title,"level",level.getSelectedItemPosition()).toString())), result->{projectId=result.optString("id"); refresh(false);},true,null);
        });
    }
    private void createTaskDialog() {
        String selected=projectId; LinearLayout form=form(); EditText name=field("任务名称",false,80); form.addView(name);
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("新建任务").setView(form).setNegativeButton("取消",null).setPositiveButton("创建",null).create(); showDialog(dialog);
        dialog.getButton(-1).setOnClickListener(v->{String title=name.getText().toString().trim(); if(title.isEmpty()){name.setError("请填写名称");return;} if(loading)return; dialog.dismiss();
            run(()->object(api.json("/api/tasks",json("name",title,"projectId",selected).toString())),result->{taskId=result.optString("id");refresh(false);},true,null);
        });
    }
    private void removeProjectDialog(JSONObject selected) {
        if(selected==null||!selected.optBoolean("owned"))return;
        if(uploads.active()!=null&&uploads.active().projectId.equals(selected.optString("id"))){toast("这个项目有附件正在上传，请完成后再删除");return;}
        final String id=selected.optString("id"),name=selected.optString("name");int count=0;
        for(JSONObject item:sorted(array(snapshot,"tasks")))if(id.equals(item.optString("projectId")))count++;
        String message="将从工作台移除项目“"+name+"”及其 "+count+" 个任务。共享用户也将无法在工作台查看。\n\n电脑里的文件和 Codex 原始对话会保留。移除后，工作台暂不支持恢复。\n\n若有任务正在执行，请先停止或等待完成。";
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("删除项目？").setMessage(message).setNegativeButton("取消",null).setPositiveButton("确认删除",null).create();showDialog(dialog);
        dialog.getButton(-1).setTextColor(0xffa44035);
        dialog.getButton(-1).setOnClickListener(v->{if(loading)return;dialog.dismiss();
            run(()->object(api.json("/api/projects/"+id+"/remove",json("confirmName",name).toString())),result->{
                for(JSONObject item:sorted(array(snapshot,"tasks")))if(id.equals(item.optString("projectId")))uncertain.remove(item.optString("id"));
                epoch++;projectId="";taskId="";searchQuery="";snapshot=new JSONObject();renderLists();refresh(false);toast("项目已移除，电脑文件已保留");
            },true,null);
        });
    }
    private void projectDialog() {
        JSONObject selected=project(); if(selected==null)return; String id=projectId; boolean owned=selected.optBoolean("owned"), admin="admin".equals(user.optString("role"));
        LinearLayout form=form(); EditText name=field("项目名称",false,80); name.setText(selected.optString("name")); name.setEnabled(owned); form.addView(name);
        CheckBox shared=new CheckBox(this); shared.setText("共享给等级符合要求的用户（只读）"); shared.setChecked(selected.optBoolean("shared")); shared.setEnabled(owned); form.addView(shared);
        Spinner level=levels(selected.optInt("level")); level.setEnabled(admin); form.addView(level); if(!admin)label(form,"项目创建后，等级由管理员调整。");
        AlertDialog dialog=new AlertDialog.Builder(this).setTitle("项目设置").setView(form).setNegativeButton("取消",null).setPositiveButton("保存",null).create(); showDialog(dialog);
        dialog.getButton(-1).setOnClickListener(v->{if(loading)return; if(owned&&name.getText().toString().trim().isEmpty()){name.setError("请填写名称");return;} JSONObject payload=new JSONObject(); if(owned){put(payload,"name",name.getText().toString().trim());put(payload,"shared",shared.isChecked());} if(admin)put(payload,"level",level.getSelectedItemPosition()); dialog.dismiss();
            run(()->object(api.json("/api/projects/"+id,payload.toString())), result->refresh(false),true,null);
        });
    }
    private void showChat() {
        JSONObject selected=task(); if(selected==null){renderLists();return;}
        uploads.account(user.optString("id"));
        if(!attachmentTask.equals(taskId)){clearAttachments();attachmentTask=taskId;}
        attachments=uploads.draft(taskId).files;
        scaffold(selected.optString("name"),selected.optString("projectName"),true);
        taskState=text(status(selected),12,MUTED);taskState.setGravity(Gravity.CENTER);taskState.setPadding(dp(16),dp(6),dp(16),dp(6)); page.addView(taskState);
        messageScroll=new ScrollView(this); messageScroll.setFillViewport(true);messageScroll.setClipToPadding(false);messageScroll.setPadding(dp(14),dp(10),dp(14),dp(14)); messageList=column(); messageScroll.addView(messageList); page.addView(messageScroll,new LinearLayout.LayoutParams(-1,0,1));
        questions=column(); messageList.addView(questions);
        if(selected.optBoolean("canExecute")) {
            LinearLayout dock=column();dock.setBackgroundColor(Color.WHITE);dock.setPadding(dp(12),dp(6),dp(12),dp(6));
            skillPicker=button("技能 · 不指定",this::chooseSkill);skillPicker.setTextSize(12);skillPicker.setMinHeight(0);skillPicker.setMinimumHeight(0);skillPicker.setPadding(dp(12),0,dp(12),0);dock.addView(skillPicker,new LinearLayout.LayoutParams(-2,dp(34)));
            attachmentRows=column();dock.addView(attachmentRows);LinearLayout input=row();input.setGravity(Gravity.BOTTOM);
            attach=iconAction("attach","添加 Word 或 PPT 附件",this::chooseAttachment);input.addView(attach,new LinearLayout.LayoutParams(dp(44),dp(50)));
            composer=field("发消息，描述你想做的事…",false,12000); composer.setSingleLine(false); composer.setInputType(InputType.TYPE_CLASS_TEXT|InputType.TYPE_TEXT_FLAG_MULTI_LINE|InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);composer.setImeOptions(EditorInfo.IME_FLAG_NO_EXTRACT_UI); composer.setMinLines(1); composer.setMaxLines(5); composer.setGravity(Gravity.TOP);composer.setBackground(ui.surface(BG,14));composer.setText(uploads.draft(taskId).text);input.addView(composer,new LinearLayout.LayoutParams(0,-2,1));
            send=primary("发送",()->{String prompt=composer.getText().toString().trim(); if(prompt.isEmpty()&&attachments.isEmpty()){toast("请填写需求或添加附件");return;}JSONArray names=new JSONArray();for(JSONObject file:attachments)names.put(file.optString("name"));JSONObject payload=json("prompt",prompt,"attachments",names);String chosen=uploads.draft(taskId).skillId;if(!chosen.isEmpty())put(payload,"skillId",chosen);taskAction("send",payload);});LinearLayout.LayoutParams sendLayout=new LinearLayout.LayoutParams(dp(64),dp(50));sendLayout.leftMargin=dp(6);input.addView(send,sendLayout);dock.addView(input);
            composerHint=text("在当前项目中执行",11,MUTED);composerHint.setGravity(Gravity.CENTER);dock.addView(composerHint);page.addView(ui.divider());page.addView(dock);
            composer.addTextChangedListener(new TextWatcher(){public void beforeTextChanged(CharSequence s,int start,int count,int after){}public void onTextChanged(CharSequence s,int start,int before,int count){saveDraft();updateControls();}public void afterTextChanged(Editable s){}});
        } else {LinearLayout footer=column();footer.setBackgroundColor(Color.WHITE);footer.setPadding(dp(16),dp(10),dp(16),dp(10));TextView readonly=text("只读任务 · 可以查看对话和保存文件",12,MUTED);readonly.setGravity(Gravity.CENTER);footer.addView(readonly);page.addView(footer);}
        messageList.setTag(taskId); historySignature=""; questionSignature="";renderAttachments(); updateControls();
    }
    private void chooseSkill(){
        if(user==null||task()==null||!task().optBoolean("canExecute")||!mobileControl()||loading)return;
        String selectedId=taskId,account=user.optString("id");
        run(()->object(api.json("/api/tasks/"+selectedId+"/skills",null)),value->{
            if(user==null||!account.equals(user.optString("id"))||!selectedId.equals(taskId)||task()==null||!task().optBoolean("canExecute"))return;
            JSONArray skills=array(value,"skills");String[] labels=new String[skills.length()+1];labels[0]="不指定（自动判断）";int checked=0;
            for(int i=0;i<skills.length();i++){JSONObject item=skills.optJSONObject(i);labels[i+1]=item.optString("title")+(item.optBoolean("available")?"":" · 暂不可用");if(uploads.draft(selectedId).skillId.equals(item.optString("id")))checked=i+1;}
            AlertDialog dialog=new AlertDialog.Builder(this).setTitle("本次需求使用的技能").setSingleChoiceItems(labels,checked,(d,index)->{
                if(user==null||!account.equals(user.optString("id"))||!selectedId.equals(taskId)||task()==null||!task().optBoolean("canExecute")||!mobileControl()){d.dismiss();return;}
                JSONObject chosen=index==0?null:skills.optJSONObject(index-1);if(chosen!=null&&!chosen.optBoolean("available")){toast("电脑尚未启用这个技能，请选择其他技能");return;}
                AttachmentUploads.Draft<JSONObject> draft=uploads.draft(selectedId);draft.skillId=chosen==null?"":chosen.optString("id");draft.skillTitle=chosen==null?"":chosen.optString("title");updateControls();d.dismiss();
            }).setNegativeButton("取消",null).create();showDialog(dialog);
        },false,null);
    }
    private void updateControls() {
        JSONObject selected=task(); if(selected==null||taskState==null)return;
        boolean owner=selected.optBoolean("canExecute"), connected=snapshot.optBoolean("connected")&&snapshot.optBoolean("signedIn");
        taskState.setText(uncertain.contains(taskId)?"结果待确认 · 请在右上角菜单刷新状态":(selected.optBoolean("busy")?"● ":"")+status(selected));
        taskState.setTextColor(uncertain.contains(taskId)?0xff976018:selected.optBoolean("busy")?GREEN:MUTED);
        if(send!=null)send.setEnabled((!loading||quietRequest)&&owner&&mobileControl()&&connected&&!selected.optBoolean("busy")&&!uncertain.contains(taskId)&&!uploads.uploading(taskId)&&hasDraft());
        if(attach!=null)attach.setEnabled((!loading||quietRequest)&&owner&&mobileControl()&&attachments.size()<3&&uploads.active()==null);
        if(skillPicker!=null){AttachmentUploads.Draft<JSONObject> draft=uploads.draft(taskId);skillPicker.setText(draft.skillId.isEmpty()?"技能 · 不指定  ▾":"技能 · "+draft.skillTitle+"  ▾");skillPicker.setEnabled((!loading||quietRequest)&&owner&&mobileControl());}
        if(composer!=null&&composerHint!=null){int length=composer.length();composerHint.setText(!mobileControl()?"已暂停发送 · 可在更多菜单恢复工作台操作":uploads.uploading(taskId)?"附件上传中 · 可以返回，完成后在本任务发送":length>=1000?length+" / 12000 字":selected.optBoolean("busy")?"电脑正在处理，你可以先写下一条需求":"在当前项目中执行 · 文件可在右上角保存");}
        if(stop!=null){stop.setVisibility(owner?View.VISIBLE:View.GONE);stop.setEnabled(!loading&&connected&&!selected.isNull("activeTurn"));}
    }
    private String connectionText() { return !snapshot.has("connected")?"":!snapshot.optBoolean("connected")?"电脑 Codex 尚未连接，请检查电脑端":!snapshot.optBoolean("signedIn")?"请先在电脑上的 Codex 登录":"已连接电脑 · 进度自动刷新"; }
    private void taskAction(String action,JSONObject payload) {
        String selected=taskId;
        run(()->object(api.json("/api/tasks/"+selected+"/"+action,payload.toString())), value->{
            if(action.equals("send")){if(composer!=null)composer.setText("");attachments.clear();AttachmentUploads.Draft<JSONObject> draft=uploads.draft(selected);draft.skillId="";draft.skillTitle="";uploads.acknowledge(selected);renderAttachments();renderUploadNotice();updateControls();}
            uncertain.remove(selected); refresh(false);
        },true,selected);
    }
    private void refresh(boolean reconcile) { refresh(reconcile,false); }
    private void refresh(boolean reconcile,boolean quiet) {
        if(user==null||loading)return;
        String selected=taskId;
        run(()->{
            JSONObject state=object(api.json("/api/status",null)); JSONObject current=find(array(state,"tasks"),selected);
            JSONObject result=json("state",state);
            if(current!=null) {
                if(reconcile&&current.optBoolean("canExecute")) api.json("/api/tasks/"+selected+"/reconcile","{}");
                put(result,"history",object(api.json("/api/history/"+selected,null)));
                if(reconcile)put(result,"state",object(api.json("/api/status",null)));
            }
            return result;
        },value->{
            snapshot=value.optJSONObject("state");user=snapshot.optJSONObject("user");
            uploads.account(user==null?"":user.optString("id"));Set<String> writable=new HashSet<>();JSONArray taskList=array(snapshot,"tasks");for(int i=0;i<taskList.length();i++){JSONObject item=taskList.optJSONObject(i);if(item!=null&&item.optBoolean("canExecute"))writable.add(item.optString("id"));}uploads.retain(writable);renderUploadNotice();
            if(showingProfile){updateProfile();hint(connectionText());return;}
            if(!selected.isEmpty()&&task()==null){taskId="";composer=null;renderLists();hint("任务已不可见或权限已变更");return;}
            if(!taskId.isEmpty()) {
                if(composer==null&&task().optBoolean("canExecute")||messageList==null||!taskId.equals(messageList.getTag())) {showChat();messageList.setTag(taskId);}
                renderHistory(value.optJSONObject("history"));renderQuestions();if(reconcile)uncertain.remove(selected);updateControls();hint(connectionText());
            } else if(!listContext.equals(projectId)||!projectId.isEmpty()&&project()==null)renderLists();
            else if(!listSignature.equals(snapshot.toString())){renderRows();hint(connectionText());}
            else hint(connectionText());
        },false,null,quiet);
    }
    private void renderHistory(JSONObject history) {
        if(history==null)return;String signature=history.toString();if(signature.equals(historySignature))return;historySignature=signature;
        int oldY=messageScroll.getScrollY(); boolean bottom=messageList.getHeight()-messageScroll.getHeight()-oldY<dp(100);
        messageList.removeAllViews();JSONArray turns=array(history,"turns");int count=0;
        for(int i=0;i<turns.length();i++){JSONObject turn=turns.optJSONObject(i);if(turn==null)continue;JSONArray items=array(turn,"items");
            for(int j=0;j<items.length();j++){JSONObject item=items.optJSONObject(j);if(item==null)continue;String type=item.optString("type"),value="";boolean own=type.equals("userMessage");
                if(own){JSONArray content=array(item,"content");StringBuilder buffer=new StringBuilder();for(int k=0;k<content.length();k++){JSONObject part=content.optJSONObject(k);if(part!=null&&"text".equals(part.optString("type")))buffer.append(part.optString("text")).append('\n');}value=buffer.toString().trim();}
                else if(type.equals("agentMessage"))value=item.optString("text");
                if(value.isEmpty())continue;if(own)value=MessageFormat.skillMessage(value);count++;LinearLayout bubble=column();bubble.setPadding(dp(14),dp(10),dp(14),dp(14));bubble.setBackground(rounded(own?ChatUi.SOFT:Color.WHITE));
                LinearLayout title=row();TextView who=text(own?"你":"Codex",12,own?MUTED:GREEN);who.setTypeface(null,Typeface.BOLD);title.addView(who,new LinearLayout.LayoutParams(0,-2,1));
                final String message=value;title.addView(ui.iconButton("copy","复制这条"+(own?"需求":"回复"),()->MessageBody.copy(this,message)),new LinearLayout.LayoutParams(dp(44),dp(40)));bubble.addView(title);
                MessageBody.add(bubble,value,!own);LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.bottomMargin=dp(16);if(own)layout.leftMargin=dp(38);else layout.rightMargin=dp(8);messageList.addView(bubble,layout);
            }
            if(!turn.isNull("error"))label(messageList,"本轮执行出现错误，请刷新状态或在电脑端查看。");
        }
        if(count==0){LinearLayout welcome=column();welcome.setPadding(dp(12),dp(38),dp(12),dp(24));TextView title=text("今天想完成什么？",23,INK);title.setTypeface(null,Typeface.BOLD);welcome.addView(title);label(welcome,"把需求发给电脑上的 Codex，\n回复和生成的文件会出现在这里。");space(welcome,18);
            if(task()!=null&&task().optBoolean("canExecute"))for(String example:new String[]{"帮我整理这个项目里的文件","根据我的要求编写一份文档","帮我开发一个小工具"}){Button suggestion=button(example,()->{if(composer!=null){composer.setText(example);composer.setSelection(composer.length());composer.requestFocus();}});LinearLayout.LayoutParams option=new LinearLayout.LayoutParams(-1,-2);option.bottomMargin=dp(8);welcome.addView(suggestion,option);}messageList.addView(welcome);}
        messageList.addView(questions);ScrollView currentScroll=messageScroll;currentScroll.post(()->{if(messageScroll!=currentScroll||taskId.isEmpty())return;if(bottom)currentScroll.fullScroll(View.FOCUS_DOWN);else currentScroll.scrollTo(0,oldY);});
    }
    private void renderQuestions() {
        JSONArray all=array(snapshot,"questions"), selected=new JSONArray();for(int i=0;i<all.length();i++){JSONObject question=all.optJSONObject(i);if(question!=null&&taskId.equals(question.optString("taskId")))selected.put(question);}
        String signature=selected.toString();if(signature.equals(questionSignature))return;questionSignature=signature;questions.removeAllViews();
        if(task()==null||!task().optBoolean("canExecute"))return;
        for(int i=0;i<selected.length();i++){JSONObject request=selected.optJSONObject(i);LinearLayout form=column();form.setPadding(dp(10),dp(8),dp(10),dp(12));form.setBackground(rounded(0xfffff4d9));label(form,"Codex 需要你的回答");Map<String,EditText> answers=new LinkedHashMap<>();JSONArray items=array(request,"questions");
            for(int j=0;j<items.length();j++){JSONObject question=items.optJSONObject(j);label(form,question.optString("question"));EditText input=field("输入回答或选择选项",question.optBoolean("isSecret"),4000);if(!question.optBoolean("isSecret")){input.setSingleLine(false);input.setMaxLines(4);}answers.put(question.optString("id"),input);form.addView(input);JSONArray options=array(question,"options");for(int k=0;k<options.length();k++){JSONObject option=options.optJSONObject(k);String title=option.optString("label");form.addView(button(title+(!option.optString("description").isEmpty()?"\n"+option.optString("description"):""),()->input.setText(title)));}}
            form.addView(primary("提交回答",()->{JSONObject values=new JSONObject();for(Map.Entry<String,EditText> answer:answers.entrySet()){String value=answer.getValue().getText().toString().trim();if(value.isEmpty()){answer.getValue().setError("请填写回答");return;}put(values,answer.getKey(),value);}taskAction("answer",json("requestId",request.opt("id"),"answers",values));}));questions.addView(form);
        }
    }
    private boolean officeName(String name){return name!=null&&name.toLowerCase(Locale.ROOT).matches(".+\\.(docx|pptx)$");}
    private void renderAttachments(){
        if(attachmentRows==null)return;attachmentRows.removeAllViews();
        for(JSONObject file:new ArrayList<>(attachments)){
            LinearLayout line=row();line.setPadding(dp(8),0,0,0);line.setBackground(ui.surface(ChatUi.SOFT,10));
            String filename=file.optString("originalName",file.optString("name"));if(filename.contains("/"))filename=filename.substring(filename.lastIndexOf('/')+1);
            TextView title=text("已上传 · 待发送\n"+filename+" · "+MessageFormat.size(file.optLong("size")),12,INK);title.setMaxLines(2);title.setEllipsize(TextUtils.TruncateAt.END);line.addView(title,new LinearLayout.LayoutParams(0,-2,1));
            Button remove=button("×",()->{attachments.remove(file);renderAttachments();updateControls();});remove.setContentDescription("不随本条需求发送："+filename+"。文件仍保留在项目中");line.addView(remove,new LinearLayout.LayoutParams(dp(44),dp(44)));LinearLayout.LayoutParams layout=new LinearLayout.LayoutParams(-1,-2);layout.bottomMargin=dp(4);attachmentRows.addView(line,layout);
        }
        attachmentRows.setVisibility(attachments.isEmpty()?View.GONE:View.VISIBLE);
    }
    private void addAttachment(JSONObject file){
        for(JSONObject existing:attachments)if(existing.optString("name").equals(file.optString("name"))){toast("已添加这个附件");return;}
        if(attachments.size()>=3){toast("每条需求最多添加 3 个附件");return;}
        attachmentTask=taskId;attachments.add(file);renderAttachments();updateControls();
    }
    private void chooseAttachment(){
        if(!mobileControl()){toast("请先在更多菜单恢复工作台操作");return;}
        if(uploads.active()!=null){toast("有附件正在上传，完成后可继续添加");return;}
        if(attachments.size()>=3){toast("每条需求最多添加 3 个附件");return;}
        showDialog(new AlertDialog.Builder(this).setTitle("添加附件 · 单个最多 " + ApiClient.FILE_LIMIT_LABEL)
            .setItems(new String[]{"从手机选择 Word / PPT","从项目文件选择"},(d,index)->{if(index==0)pickAttachment();else chooseProjectAttachment();}).setNegativeButton("取消",null).create());
    }
    private void pickAttachment(){
        pickAttachment(false);
    }
    private void pickAttachment(boolean alternate){
        importTask=taskId;importUser=user.optString("id");alternateAttachmentPicker=alternate;
        Intent intent=AttachmentSource.picker(alternate);
        try{startActivityForResult(intent,72);}catch(ActivityNotFoundException error){importTask=null;importUser=null;toast("手机没有可用的文件选择工具");}
    }
    private void chooseProjectAttachment(){
        String selected=taskId;run(()->json("files",new JSONArray(api.json("/api/tasks/"+selected+"/files",null))),value->{
            List<JSONObject> available=new ArrayList<>();for(JSONObject file:sorted(array(value,"files")))if(file.optString("name").matches("attachments/[0-9a-f-]{36}/[^/]+")&&officeName(file.optString("name")))available.add(file);
            if(available.isEmpty()){toast("项目中还没有上传的 Word / PPT 附件");return;}
            String[] names=new String[available.size()];for(int i=0;i<names.length;i++)names[i]=available.get(i).optString("name")+"\n"+MessageFormat.size(available.get(i).optLong("size"));
            showDialog(new AlertDialog.Builder(this).setTitle("选择项目附件").setItems(names,(d,index)->addAttachment(available.get(index))).setNegativeButton("取消",null).create());
        },false,null);
    }
    private void startUpload(Uri uri,int resultFlags){
        if(user==null||task()==null||!task().optBoolean("canExecute")||!mobileControl()||uploads.active()!=null)return;
        saveDraft();uploads.account(user.optString("id"));
        AttachmentUploads.Job<JSONObject> job=uploads.begin(taskId,task().optString("projectId"),task().optString("name"),alternateAttachmentPicker);
        // A later login must never supply credentials to a previously selected upload.
        final String session=cookies.get(ApiClient.ORIGIN);
        ApiClient uploadApi=new ApiClient(ApiClient.ORIGIN,new ApiClient.Cookies(){public String get(String origin){return session;}public void set(String origin,String value){}});
        renderUploadNotice();updateControls();
        uploadWorker.execute(()->{
            JSONObject value=null;Exception failure=null;
            try{
                if(job.abandoned)throw new InterruptedIOException("Account or task changed");
                try(AttachmentSource.Staged staged=AttachmentSource.read(getContentResolver(),uri,getCacheDir(),resultFlags)){
                    if(job.abandoned)throw new InterruptedIOException("Account or task changed");
                    main.post(()->{if(!destroyed&&uploads.accepts(job)){job.transferring=true;renderUploadNotice();}});
                    value=object(uploadApi.upload("/api/tasks/"+job.taskId+"/attachments?name="+URLEncoder.encode(staged.name,"UTF-8"),staged.file));
                }
            }catch(Exception error){failure=error;}
            final JSONObject result=value;final Exception error=failure;
            main.post(()->{
                if(destroyed||!uploads.finish(job,result,error))return;
                if(error instanceof ApiClient.Failure&&((ApiClient.Failure)error).status==401){showError(error,false,null);return;}
                renderUploadNotice();if(job.taskId.equals(taskId)){renderAttachments();if(error!=null&&foreground&&openDialogs==0)showUploadFailure(job);}updateControls();
                if(error==null)toast("附件已上传到“"+job.taskName+"”，回到该任务即可发送");
                else if(!job.taskId.equals(taskId))toast("“"+job.taskName+"”的附件上传失败，点顶部状态查看");
            });
        });
    }
    private void renderUploadNotice(){
        if(uploadNotice==null)return;AttachmentUploads.Job<JSONObject> job=uploads.notice();
        if(user==null||job==null){uploadNotice.setVisibility(View.GONE);return;}
        String status=job.complete?(job.error==null?"附件已上传":"附件上传失败"):(job.transferring?"正在上传附件":"正在读取附件");
        uploadNotice.setText(status+" · "+job.taskName+"\n"+(job.complete?(job.error==null?"回到原任务发送":"点此查看详情"):"可以返回或切换任务，上传会继续"));uploadNotice.setVisibility(View.VISIBLE);
    }
    private boolean openUploadTask(AttachmentUploads.Job<JSONObject> job){
        if(user==null||!user.optString("id").equals(job.account))return false;
        JSONObject target=find(array(snapshot,"tasks"),job.taskId);
        if(target==null||!target.optBoolean("canExecute")){toast("原任务已不可用，请刷新列表");return false;}
        if(job.taskId.equals(taskId))return true;
        saveDraft();epoch++;clearAttachments();showingProfile=false;projectId=job.projectId;taskId=job.taskId;showChat();refresh(false);return true;
    }
    private void showUploadFailure(AttachmentUploads.Job<JSONObject> job){
        if(job.error==null||user==null||!user.optString("id").equals(job.account))return;
        Exception error=job.error;String message="上传结果待核实，请先在原任务的项目文件中查看，避免重复上传。";
        if(error instanceof ApiClient.Failure){ApiClient.Failure failure=(ApiClient.Failure)error;
            if(failure.verification)message="需要连接验证，请在“我的 → 连接信息”完成后重试。";
            else if(failure.status<500)try{message=new JSONObject(failure.getMessage()).optString("error",message);}catch(JSONException ignored){}
        }
        AlertDialog.Builder dialog=new AlertDialog.Builder(this).setTitle("附件未上传 · "+job.taskName).setMessage(message).setNegativeButton("关闭",null);
        if(error instanceof AttachmentSource.ReadFailure){
            AttachmentSource.ReadFailure readFailure=(AttachmentSource.ReadFailure)error;
            dialog.setPositiveButton("换一种方式选择",(d,w)->{if(uploads.active()==null&&openUploadTask(job))pickAttachment(!job.alternatePicker);});
            dialog.setNeutralButton("复制诊断信息",(d,w)->{android.content.ClipboardManager clipboard=(android.content.ClipboardManager)getSystemService(CLIPBOARD_SERVICE);clipboard.setPrimaryClip(ClipData.newPlainText("附件读取诊断",readFailure.detail));toast("诊断信息已复制，不包含文件内容或路径");});
        }
        showDialog(dialog.create());
    }
    private void showFiles() {
        String selected=taskId;
        run(()->json("files",new JSONArray(api.json("/api/tasks/"+selected+"/files",null))),value->{
            JSONArray files=array(value,"files");if(files.length()==0){toast("项目中还没有可下载的文件");return;}
            String[] names=new String[files.length()];for(int i=0;i<files.length();i++){JSONObject file=files.optJSONObject(i);names[i]=file.optString("name")+"\n"+MessageFormat.size(file.optLong("size"));}
            showDialog(new AlertDialog.Builder(this).setTitle("项目文件 · 点击保存").setItems(names,(d,index)->{
                exportTask=selected;exportName=files.optJSONObject(index).optString("name");exportUser=user.optString("id");
                Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT);intent.addCategory(Intent.CATEGORY_OPENABLE);intent.setType("application/octet-stream");String name=exportName.replace('\\','/');intent.putExtra(Intent.EXTRA_TITLE,name.substring(name.lastIndexOf('/')+1));
                try{startActivityForResult(intent,71);}catch(ActivityNotFoundException error){exportTask=null;exportName=null;exportUser=null;toast("手机没有可用的文件保存工具");}
            }).setNegativeButton("关闭",null).create());
        },false,null);
    }
    @Override protected void onActivityResult(int request,int result,Intent data) {
        super.onActivityResult(request,result,data);
        if(request==72){
            String selected=importTask,account=importUser;importTask=null;importUser=null;
            if(result!=RESULT_OK||data==null||data.getData()==null)return;
            if(user==null||!user.optString("id").equals(account)||selected==null||!selected.equals(taskId)){toast("账号或任务已变更，请重新选择附件");return;}
            if(loading){toast("正在更新，请稍后重新选择附件");return;}
            startUpload(data.getData(),data.getFlags());return;
        }
        if(request!=71)return;
        if(result!=RESULT_OK||data==null||data.getData()==null){exportTask=null;exportName=null;exportUser=null;return;}
        if(user==null||!user.optString("id").equals(exportUser)||exportTask==null){toast("账号已变更，请重新选择文件");return;}
        final Uri uri=data.getData();final String selected=exportTask,name=exportName;exportTask=null;exportName=null;exportUser=null;
        if(loading){toast("正在刷新，请稍后重新保存文件");return;}
        hint("正在下载文件，请稍候…");
        run(()->{
            File staged=File.createTempFile("download-",".tmp",getCacheDir());
            try{
                api.download("/api/tasks/"+selected+"/file?name="+URLEncoder.encode(name,"UTF-8"),staged);
                try(InputStream input=new FileInputStream(staged);OutputStream out=getContentResolver().openOutputStream(uri,"wt")){
                    if(out==null)throw new ApiClient.Failure(400,json("error","无法写入所选位置，请重新保存").toString(),false);
                    ApiClient.copyFile(input,out);
                }catch(IOException error){throw new ApiClient.Failure(400,json("error","文件未完整保存，请检查手机空间后重新保存").toString(),false);}
                return new JSONObject();
            }finally{java.nio.file.Files.deleteIfExists(staged.toPath());}
        },value->{hint(connectionText());toast("文件已保存到你选择的位置");},false,null);
    }
    private interface Work { JSONObject perform() throws Exception; }
    private interface Result { void accept(JSONObject value); }
    private void run(Work work,Result result,boolean mutation,String affectedTask) {
        run(work,result,mutation,affectedTask,false);
    }
    private void run(Work work,Result result,boolean mutation,String affectedTask,boolean quiet) {
        if(loading||destroyed)return;loading=true;quietRequest=quiet;int generation=epoch;if(progress!=null)progress.setVisibility(quiet?View.INVISIBLE:View.VISIBLE);if(!taskId.isEmpty())updateControls();
        worker.execute(()->{
            JSONObject value=null;Exception failure=null;try{value=work.perform();}catch(Exception error){failure=error;}
            JSONObject output=value;Exception error=failure;
            main.post(()->{if(destroyed)return;loading=false;quietRequest=false;if(progress!=null)progress.setVisibility(View.INVISIBLE);if(generation!=epoch){updateControls();return;}
                if(error==null)result.accept(output);else showError(error,mutation,affectedTask);
                if(!taskId.isEmpty())updateControls();
            });
        });
    }
    private void showError(Exception error,boolean mutation,String affectedTask) {
        if(error instanceof ApiClient.Failure){ApiClient.Failure failure=(ApiClient.Failure)error;
            if(failure.status==401){epoch++;user=null;snapshot=new JSONObject();projectId="";taskId="";searchQuery="";uncertain.clear();exportTask=null;showLogin();hint("登录已过期，或账号密码不正确，请重新登录");return;}
            if(failure.status==403||failure.status==404){taskId="";projectId="";snapshot=new JSONObject();renderLists();}
            if(failure.verification){hint(showingProfile?"需要连接验证：点“连接信息”→“连接验证”。":"需要连接验证：点右上角“更多”→“连接与账号”。");if(mutation&&affectedTask!=null)uncertain.add(affectedTask);return;}
            if(mutation&&affectedTask!=null&&failure.status>=500)uncertain.add(affectedTask);
            String message="操作失败（"+failure.status+"）";try{message=new JSONObject(failure.getMessage()).optString("error",message);}catch(JSONException ignored){}
            hint(message);
            toast(message);
            return;
        }
        if(mutation&&affectedTask!=null)uncertain.add(affectedTask);
        String message=mutation?"连接中断，操作可能已提交。请刷新核对，避免重复操作。":"暂时无法连接，请检查手机网络和电脑工作台。";
        hint(message);if(mutation)toast(message);
    }
    private void hint(String message) { if(notice!=null){notice.setText(message);boolean routine=message.isEmpty()||message.startsWith("已连接电脑")||message.equals("连接正常，请登录")||message.equals("已退出账号");notice.setVisibility(routine?View.GONE:View.VISIBLE);} }
    private void toast(String message) { Toast.makeText(this,message,Toast.LENGTH_LONG).show(); }
    private static JSONObject object(String value) throws JSONException { return new JSONObject(value); }
    private static JSONObject json(Object... pairs) { JSONObject value=new JSONObject();for(int i=0;i<pairs.length;i+=2)put(value,(String)pairs[i],pairs[i+1]);return value; }
    private static void put(JSONObject value,String key,Object item) { try{value.put(key,item);}catch(JSONException error){throw new IllegalArgumentException(error);} }
}
