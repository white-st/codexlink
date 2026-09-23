param([string]$JdkPath=$env:JAVA_HOME, [string]$SdkPath=$env:ANDROID_HOME, [string]$BuildToolsPath=$env:ANDROID_BUILD_TOOLS, [string]$AndroidJar=$env:ANDROID_JAR)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskBuild=Join-Path $taskRoot ('android\build\upload-ui-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
$taskJdk=Join-Path $JdkPath 'bin'
$taskSdk=$SdkPath;$taskTools=$BuildToolsPath;$taskJar=$AndroidJar
foreach($taskPart in @('src','classes','generated','dex')){New-Item -ItemType Directory -Path (Join-Path $taskBuild $taskPart) -Force | Out-Null}
function Invoke-Checked([string]$Exe,[string[]]$Arguments){& $Exe @Arguments;if($LASTEXITCODE -ne 0){throw "UI fixture build failed: $Exe"}}
Get-ChildItem -LiteralPath "$taskRoot\android\src\com\codexlink\mobile" -Filter '*.java' | ForEach-Object {Copy-Item -LiteralPath $_.FullName -Destination "$taskBuild\src"}
$taskApi=Join-Path $taskBuild 'src\ApiClient.java';[IO.File]::WriteAllText($taskApi,[IO.File]::ReadAllText($taskApi).Replace('https://codexlink.example.invalid','http://127.0.0.1:47816'),[Text.UTF8Encoding]::new($false))
$taskManifest=[IO.File]::ReadAllText("$taskRoot\android\AndroidManifest.xml").Replace('package="com.codexlink.mobile"','package="com.codexlink.uploaduitest"').Replace('android:name=".','android:name="com.codexlink.mobile.').Replace('android:label="CodexLink"','android:label="Upload UI Fixture"').Replace('android:usesCleartextTraffic="false"','android:usesCleartextTraffic="true"')
[IO.File]::WriteAllText("$taskBuild\AndroidManifest.xml",$taskManifest,[Text.UTF8Encoding]::new($false))
Invoke-Checked "$taskTools\aapt2.exe" @('compile','--dir',"$taskRoot\android\res",'-o',"$taskBuild\resources.zip")
Invoke-Checked "$taskTools\aapt2.exe" @('link','-o',"$taskBuild\unsigned.apk",'--manifest',"$taskBuild\AndroidManifest.xml",'-I',$taskJar,'--java',"$taskBuild\generated","$taskBuild\resources.zip")
$taskSources=@(Get-ChildItem -LiteralPath "$taskBuild\src","$taskBuild\generated" -Recurse -Filter '*.java' | ForEach-Object {$_.FullName})
Invoke-Checked "$taskJdk\javac.exe" (@('-encoding','UTF-8','--release','8','-cp',$taskJar,'-d',"$taskBuild\classes")+$taskSources)
Invoke-Checked "$taskJdk\jar.exe" @('cf',"$taskBuild\classes.jar",'-C',"$taskBuild\classes",'.')
Invoke-Checked "$taskJdk\java.exe" @('-cp',"$taskTools\lib\d8.jar",'com.android.tools.r8.D8','--lib',$taskJar,'--min-api','26','--output',"$taskBuild\dex","$taskBuild\classes.jar")
Invoke-Checked "$taskJdk\jar.exe" @('uf',"$taskBuild\unsigned.apk",'-C',"$taskBuild\dex",'classes.dex')
Invoke-Checked "$taskTools\zipalign.exe" @('-f','4',"$taskBuild\unsigned.apk","$taskBuild\aligned.apk")
Invoke-Checked "$taskJdk\java.exe" @('-jar',"$taskTools\lib\apksigner.jar",'sign','--ks',"$taskRoot\.runtime\android-signing\test-release.p12",'--ks-key-alias','codexlink-test','--ks-pass',"file:$taskRoot\.runtime\android-signing\password.txt",'--out',"$taskBuild\fixture.apk","$taskBuild\aligned.apk")
[IO.File]::WriteAllText("$taskRoot\.runtime\upload-ui-apk.txt","$taskBuild\fixture.apk",[Text.UTF8Encoding]::new($false))
Write-Output "Isolated UI fixture: $taskBuild\fixture.apk"
