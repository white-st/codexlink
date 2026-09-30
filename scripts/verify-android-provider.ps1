param([string]$Serial='emulator-5554', [string]$JdkPath=$env:JAVA_HOME, [string]$SdkPath=$env:ANDROID_HOME, [string]$BuildToolsPath=$env:ANDROID_BUILD_TOOLS, [string]$AndroidJar=$env:ANDROID_JAR)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskJdk=Join-Path $JdkPath 'bin'
$taskSdk=$SdkPath
$taskTools=$BuildToolsPath
$taskJar=$AndroidJar
$taskAdb=Join-Path $taskSdk 'platform-tools\adb.exe'
$taskBuild=Join-Path $taskRoot ('android\build\provider-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
foreach($taskPart in @('classes','dex','assets')){New-Item -ItemType Directory -Path (Join-Path $taskBuild $taskPart) -Force | Out-Null}
function Invoke-Checked([string]$Exe,[string[]]$Arguments){& $Exe @Arguments;if($LASTEXITCODE -ne 0){throw "Provider verification failed ($LASTEXITCODE): $Exe"}}
$taskFixtures=Join-Path $taskRoot 'test\fixtures\attachments'
Copy-Item -LiteralPath (Get-ChildItem -LiteralPath $taskFixtures -Filter '*.docx' | Select-Object -First 1).FullName -Destination "$taskBuild\assets\word.docx"
Copy-Item -LiteralPath (Get-ChildItem -LiteralPath $taskFixtures -Filter '*.pptx' | Select-Object -First 1).FullName -Destination "$taskBuild\assets\slides.pptx"
foreach($taskExt in @('jpg','png','webp')){Copy-Item -LiteralPath (Join-Path $taskFixtures ("vision-fixture."+$taskExt)) -Destination (Join-Path "$taskBuild\assets" ("vision-fixture."+$taskExt))}
$taskSource=Join-Path $taskRoot 'android\src\com\codexlink\mobile'
$taskTests=Join-Path $taskRoot 'android\tests\provider'
Invoke-Checked "$taskJdk\javac.exe" @('-encoding','UTF-8','--release','8','-cp',$taskJar,'-d',"$taskBuild\classes","$taskSource\ApiClient.java","$taskSource\OfficeAttachment.java","$taskSource\AttachmentFile.java","$taskSource\AttachmentSource.java","$taskTests\AttachmentProviderTest.java","$taskTests\FixtureProvider.java")
Invoke-Checked "$taskJdk\jar.exe" @('cf',"$taskBuild\classes.jar",'-C',"$taskBuild\classes",'.')
Invoke-Checked "$taskJdk\java.exe" @('-cp',"$taskTools\lib\d8.jar",'com.android.tools.r8.D8','--lib',$taskJar,'--min-api','26','--output',"$taskBuild\dex","$taskBuild\classes.jar")
Invoke-Checked "$taskTools\aapt2.exe" @('link','-o',"$taskBuild\unsigned.apk",'--manifest',"$taskTests\AndroidManifest.xml",'-I',$taskJar,'-A',"$taskBuild\assets")
Invoke-Checked "$taskJdk\jar.exe" @('uf',"$taskBuild\unsigned.apk",'-C',"$taskBuild\dex",'classes.dex')
Invoke-Checked "$taskTools\zipalign.exe" @('-f','4',"$taskBuild\unsigned.apk","$taskBuild\aligned.apk")
Invoke-Checked "$taskJdk\java.exe" @('-jar',"$taskTools\lib\apksigner.jar",'sign','--ks',"$taskRoot\.runtime\android-signing\test-release.p12",'--ks-key-alias','codexlink-test','--ks-pass',"file:$taskRoot\.runtime\android-signing\password.txt",'--out',"$taskBuild\provider.apk","$taskBuild\aligned.apk")
$taskExisting=& $taskAdb -s $Serial shell pm path com.codexlink.attachmenttest
if($taskExisting -match 'package:'){throw 'The isolated test package already exists; do not replace an unknown installation.'}
$taskInstalled=$false
try{
    Invoke-Checked $taskAdb @('-s',$Serial,'install',"$taskBuild\provider.apk");$taskInstalled=$true
    $taskResult=& $taskAdb -s $Serial shell am instrument -w com.codexlink.attachmenttest/com.codexlink.mobile.AttachmentProviderTest
    $taskResult | Write-Output
    if($LASTEXITCODE -ne 0 -or ($taskResult -join "`n") -notmatch 'result=PASS:'){throw 'Native provider checks did not pass'}
    [IO.File]::WriteAllText((Join-Path $taskRoot '.runtime\android-provider-latest.txt'),($taskResult -join "`n"),[Text.UTF8Encoding]::new($false))
}finally{if($taskInstalled){Invoke-Checked $taskAdb @('-s',$Serial,'uninstall','com.codexlink.attachmenttest')}}
