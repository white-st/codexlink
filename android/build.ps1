param(
    [string]$JdkPath = $env:JAVA_HOME,
    [string]$BuildToolsPath = $env:ANDROID_BUILD_TOOLS,
    [string]$AndroidJar = $env:ANDROID_JAR,
    [string]$ServerOrigin = $env:CODEXLINK_ORIGIN,
    [switch]$Publish
)
$ErrorActionPreference = 'Stop'
foreach ($taskSetting in @('JdkPath','BuildToolsPath','AndroidJar','ServerOrigin')) {
    if ([string]::IsNullOrWhiteSpace((Get-Variable -Name $taskSetting -ValueOnly))) { throw "Missing $taskSetting. See docs/ANDROID.md." }
}
$taskServerUri = $null
if ($ServerOrigin -cnotmatch '^https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?/?$' -or
    -not [Uri]::TryCreate($ServerOrigin,[UriKind]::Absolute,[ref]$taskServerUri) -or
    $taskServerUri.HostNameType -eq [UriHostNameType]::Unknown) { throw 'ServerOrigin must be an HTTPS origin without credentials, path, query or fragment.' }
$ServerOrigin = $taskServerUri.GetLeftPart([UriPartial]::Authority)

$taskRoot = $PSScriptRoot
$taskWorkspace = Split-Path $taskRoot -Parent
[xml]$taskManifest = [IO.File]::ReadAllText((Join-Path $taskRoot 'AndroidManifest.xml'))
$taskVersion = $taskManifest.manifest.GetAttribute('versionName', 'http://schemas.android.com/apk/res/android')
$taskVersionCode = [int]$taskManifest.manifest.GetAttribute('versionCode', 'http://schemas.android.com/apk/res/android')
if ($taskVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Unexpected version format' }
$taskBuild = Join-Path $taskRoot ('build\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0,6))
$taskOutput = Join-Path $taskRoot 'output'
$taskJava = Join-Path $JdkPath 'bin\java.exe'
$taskJavac = Join-Path $JdkPath 'bin\javac.exe'
$taskJar = Join-Path $JdkPath 'bin\jar.exe'
$taskAapt = Join-Path $BuildToolsPath 'aapt2.exe'
$taskAlign = Join-Path $BuildToolsPath 'zipalign.exe'
$taskD8 = Join-Path $BuildToolsPath 'lib\d8.jar'
$taskSigner = Join-Path $BuildToolsPath 'lib\apksigner.jar'
foreach ($taskFile in @($taskJava,$taskJavac,$taskJar,$taskAapt,$taskAlign,$taskD8,$taskSigner,$AndroidJar)) {
    if (-not (Test-Path -LiteralPath $taskFile)) { throw "Required build tool is missing: $taskFile" }
}
foreach ($taskDirectory in @($taskBuild,$taskOutput,"$taskBuild\classes","$taskBuild\generated","$taskBuild\dex","$taskBuild\tests","$taskBuild\src")) { New-Item -ItemType Directory -Path $taskDirectory -Force | Out-Null }
# Configure only a build copy; the repository keeps a non-routable example origin.
$taskSourceRoot = Join-Path $taskBuild 'src'
Copy-Item -LiteralPath (Join-Path $taskRoot 'src\com') -Destination $taskSourceRoot -Recurse
$taskApiFile = Join-Path $taskSourceRoot 'com\codexlink\mobile\ApiClient.java'
$taskApiText = [IO.File]::ReadAllText($taskApiFile)
if (-not $taskApiText.Contains('https://codexlink.example.invalid')) { throw 'Expected repository origin placeholder missing' }
[IO.File]::WriteAllText($taskApiFile,$taskApiText.Replace('https://codexlink.example.invalid',$ServerOrigin),[Text.UTF8Encoding]::new($false))
function Invoke-Checked([string]$Executable,[string[]]$Arguments) {
    & $Executable @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Build step failed ($LASTEXITCODE): $Executable" }
}
Invoke-Checked $taskJavac @('-J-Duser.language=en','-encoding','UTF-8','--release','8','-d',"$taskBuild\tests","$taskSourceRoot\com\codexlink\mobile\ApiClient.java","$taskRoot\tests\TransportTest.java")
Invoke-Checked $taskJava @('-cp',"$taskBuild\tests",'com.codexlink.mobile.TransportTest')
Invoke-Checked $taskJavac @('-J-Duser.language=en','-encoding','UTF-8','--release','8','-cp',"$taskBuild\tests",'-d',"$taskBuild\tests","$taskSourceRoot\com\codexlink\mobile\OfficeAttachment.java","$taskRoot\tests\OfficeAttachmentTest.java")
$taskWordFixture = (Get-ChildItem -LiteralPath "$taskWorkspace\test\fixtures\attachments" -Filter '*.docx' | Select-Object -First 1).FullName
$taskPptFixture = (Get-ChildItem -LiteralPath "$taskWorkspace\test\fixtures\attachments" -Filter '*.pptx' | Select-Object -First 1).FullName
Invoke-Checked $taskJava @('-Xmx32m','-cp',"$taskBuild\tests",'com.codexlink.mobile.OfficeAttachmentTest',$taskWordFixture,$taskPptFixture)
Invoke-Checked $taskJavac @('-J-Duser.language=en','-encoding','UTF-8','--release','8','-cp',"$taskBuild\tests",'-d',"$taskBuild\tests","$taskSourceRoot\com\codexlink\mobile\ReleaseInfo.java","$taskRoot\tests\UpdateTest.java")
Invoke-Checked $taskJava @('-Xmx32m','-cp',"$taskBuild\tests",'com.codexlink.mobile.UpdateTest')
Invoke-Checked $taskJavac @('-J-Duser.language=en','-encoding','UTF-8','--release','8','-cp',"$taskBuild\tests",'-d',"$taskBuild\tests","$taskRoot\tests\LargeFileTest.java")
Invoke-Checked $taskJava @('-Xmx32m','-cp',"$taskBuild\tests",'com.codexlink.mobile.LargeFileTest')
Invoke-Checked $taskJavac @('-J-Duser.language=en','-encoding','UTF-8','--release','8','-d',"$taskBuild\tests","$taskSourceRoot\com\codexlink\mobile\MessageFormat.java","$taskRoot\tests\MessageFormatTest.java")
Invoke-Checked $taskJava @('-cp',"$taskBuild\tests",'com.codexlink.mobile.MessageFormatTest')
Invoke-Checked $taskJavac @('-J-Duser.language=en','-encoding','UTF-8','--release','8','-d',"$taskBuild\tests","$taskSourceRoot\com\codexlink\mobile\AttachmentUploads.java","$taskRoot\tests\AttachmentUploadsTest.java")
Invoke-Checked $taskJava @('-cp',"$taskBuild\tests",'com.codexlink.mobile.AttachmentUploadsTest')
Invoke-Checked $taskJavac @('-J-Duser.language=en','-encoding','UTF-8','--release','8','-d',"$taskBuild\tests","$taskSourceRoot\com\codexlink\mobile\ConversationSync.java","$taskSourceRoot\com\codexlink\mobile\ConversationMemory.java","$taskRoot\tests\ConversationSyncTest.java")
Invoke-Checked $taskJava @('-Xmx32m','-cp',"$taskBuild\tests",'com.codexlink.mobile.ConversationSyncTest')
Invoke-Checked $taskAapt @('compile','--dir',"$taskRoot\res",'-o',"$taskBuild\resources.zip")
Invoke-Checked $taskAapt @('link','-o',"$taskBuild\resources.apk",'--manifest',"$taskRoot\AndroidManifest.xml",'-I',$AndroidJar,'--java',"$taskBuild\generated",'--auto-add-overlay',"$taskBuild\resources.zip")
$taskSources = @(Get-ChildItem -LiteralPath "$taskSourceRoot","$taskBuild\generated" -Filter '*.java' -Recurse | ForEach-Object { $_.FullName })
Invoke-Checked $taskJavac (@('-J-Duser.language=en','-encoding','UTF-8','--release','8','-classpath',$AndroidJar,'-d',"$taskBuild\classes") + $taskSources)
Invoke-Checked $taskJar @('cf',"$taskBuild\classes.jar",'-C',"$taskBuild\classes",'.')
Invoke-Checked $taskJava @('-cp',$taskD8,'com.android.tools.r8.D8','--lib',$AndroidJar,'--min-api','26','--output',"$taskBuild\dex","$taskBuild\classes.jar")
Copy-Item -LiteralPath "$taskBuild\resources.apk" -Destination "$taskBuild\unsigned.apk"
Invoke-Checked $taskJar @('uf',"$taskBuild\unsigned.apk",'-C',"$taskBuild\dex",'classes.dex')
Invoke-Checked $taskAlign @('-f','4',"$taskBuild\unsigned.apk","$taskBuild\aligned.apk")
$taskKeyDir = Join-Path $taskWorkspace '.runtime\android-signing'
New-Item -ItemType Directory -Path $taskKeyDir -Force | Out-Null
$taskKeyStore = Join-Path $taskKeyDir 'test-release.p12'
$taskPassword = Join-Path $taskKeyDir 'password.txt'
if (-not (Test-Path -LiteralPath $taskKeyStore)) {
    if (-not (Test-Path -LiteralPath $taskPassword)) {
        $taskBytes = New-Object byte[] 32
        $taskRng = [Security.Cryptography.RandomNumberGenerator]::Create()
        $taskRng.GetBytes($taskBytes); $taskRng.Dispose()
        [IO.File]::WriteAllText($taskPassword,[Convert]::ToBase64String($taskBytes),[Text.UTF8Encoding]::new($false))
    }
    Invoke-Checked (Join-Path $JdkPath 'bin\keytool.exe') @('-genkeypair','-keystore',$taskKeyStore,'-storetype','PKCS12','-storepass:file',$taskPassword,'-keypass:file',$taskPassword,'-alias','codexlink-test','-keyalg','RSA','-keysize','2048','-validity','3650','-dname','CN=CodexLink Local Test','-noprompt')
}
$taskApkName = 'CodexLink-' + $taskVersion + '.apk'
$taskApk = Join-Path $taskOutput $taskApkName
Invoke-Checked $taskJava @('-jar',$taskSigner,'sign','--ks',$taskKeyStore,'--ks-key-alias','codexlink-test','--ks-pass',('file:'+$taskPassword),'--out',$taskApk,"$taskBuild\aligned.apk")
Invoke-Checked $taskJava @('-jar',$taskSigner,'verify','--verbose',$taskApk)
Invoke-Checked $taskAlign @('-c','4',$taskApk)
Invoke-Checked $taskAapt @('dump','badging',$taskApk)
$taskHashStream = [IO.File]::OpenRead($taskApk)
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash($taskHashStream)).Replace('-','').ToLowerInvariant() }
finally { $taskHashStream.Dispose(); $taskHasher.Dispose() }
$taskMeta = @{ version=$taskVersion; versionCode=$taskVersionCode; packageName=$taskManifest.manifest.package; minSdk=26; notes=[IO.File]::ReadAllText((Join-Path $taskRoot 'release-notes.txt')).Trim(); file=$taskApkName; sha256=$taskHash; size=(Get-Item -LiteralPath $taskApk).Length; builtAt=(Get-Date).ToUniversalTime().ToString('o'); minAndroid='8.0'; origin=$ServerOrigin } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $taskOutput 'release.json'),$taskMeta,[Text.UTF8Encoding]::new($false))
if ($Publish) {
    $taskDownloads = Join-Path $taskWorkspace 'public\downloads'
    New-Item -ItemType Directory -Path $taskDownloads -Force | Out-Null
    Copy-Item -LiteralPath $taskApk -Destination (Join-Path $taskDownloads $taskApkName)
    Copy-Item -LiteralPath (Join-Path $taskOutput 'release.json') -Destination (Join-Path $taskDownloads 'release.json')
}
Write-Output "APK ready: $taskApk"
Write-Output "SHA256: $taskHash"
