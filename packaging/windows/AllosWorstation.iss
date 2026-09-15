; Optional Inno Setup wrapper around dist\AllosWorstation-portable\
; Portable zip remains the supported path. MSI is a follow-up.
;
; Preferred compile:
;   npm run pack:windows:installer
;   or scripts\windows\Build-InnoInstaller.ps1
; That helper builds the portable folder if needed and locates ISCC.exe.
;
; Manual: npm run pack:windows, then Inno Setup 6 (https://jrsoftware.org/isinfo.php).

#ifndef MyAppVersion
#define MyAppVersion "0.1.0"
#endif
#define MyAppName "AllosWorstation DescribePrint"
#define MyAppPublisher "AllosWorstation"
#define SourceDir "..\..\dist\AllosWorstation-portable"

#ifnexist "..\..\dist\AllosWorstation-portable\Start-DescribePrint.cmd"
  #error Portable folder missing. Run npm run pack:windows, or scripts\windows\Build-InnoInstaller.ps1. Inno Setup 6: https://jrsoftware.org/isinfo.php
#endif

[Setup]
AppId={{A11C5A70-DE5C-41BE-9F01-A1105D35C21E}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL=https://github.com/Cloverbandit1/DescribePrint
DefaultDirName={userpf}\AllosWorstation\DescribePrint
DefaultGroupName=AllosWorstation
DisableProgramGroupPage=yes
OutputDir=..\..\dist
OutputBaseFilename=AllosWorstation-DescribePrint-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
LicenseFile=..\..\LICENSE
InfoBeforeFile=README.md
InfoAfterFile=InfoAfter.txt
; Setup pack needs Node.js LTS on PATH. This installer does not bundle Node.
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Start DescribePrint"; Filename: "{app}\Start-DescribePrint.cmd"; WorkingDir: "{app}"
Name: "{group}\Setup DescribePrint"; Filename: "{app}\Setup-DescribePrint.cmd"; WorkingDir: "{app}"
Name: "{userdesktop}\Start DescribePrint"; Filename: "{app}\Start-DescribePrint.cmd"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "{app}\Setup-DescribePrint.cmd"; Description: "Run first-time setup (npm, OpenSCAD, .env.local, health)"; Flags: postinstall skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  BatDir, BatPath, Template, HintDir, HintPath, Repo: string;
begin
  if CurStep = ssPostInstall then
  begin
    Repo := ExpandConstant('{app}');
    BatDir := ExpandConstant('{userdesktop}\AllosWorstation');
    BatPath := BatDir + '\Start DescribePrint.bat';
    Template := ExpandConstant('{app}\scripts\windows\templates\Start DescribePrint.bat');
    ForceDirectories(BatDir);
    { Shared detector bat -- do not bake {app} here (OneDrive syncs this file). }
    if FileExists(Template) then
      FileCopy(Template, BatPath, False)
    else
      SaveStringToFile(BatPath,
        '@echo off' + #13#10 +
        'setlocal EnableExtensions' + #13#10 +
        'set "TARGET=%USERPROFILE%\AllosWorstation\DescribePrint"' + #13#10 +
        'if not exist "%TARGET%\Start-DescribePrint.cmd" set "TARGET=%~dp0DescribePrint"' + #13#10 +
        'cd /d "%TARGET%"' + #13#10 +
        'call "%TARGET%\Start-DescribePrint.cmd"' + #13#10, False);
    HintDir := ExpandConstant('{localappdata}\AllosWorstation');
    HintPath := HintDir + '\repo-path.txt';
    ForceDirectories(HintDir);
    SaveStringToFile(HintPath, Repo + #13#10, False);
  end;
end;
