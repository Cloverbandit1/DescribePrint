; Optional Inno Setup wrapper around dist\AllosWorstation-portable\
; Build the portable folder first (npm run pack:windows), then compile this
; with Inno Setup 6. MSI / official signed installer is a follow-up.

#define MyAppName "AllosWorstation DescribePrint"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "AllosWorstation"
#define SourceDir "..\..\dist\AllosWorstation-portable"

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
; Setup pack needs Node.js LTS on PATH — this installer does not bundle Node.
SetupLogging=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\Start DescribePrint"; Filename: "{app}\Start-DescribePrint.cmd"; WorkingDir: "{app}"
Name: "{group}\Setup DescribePrint"; Filename: "{app}\Setup-DescribePrint.cmd"; WorkingDir: "{app}"

[Run]
Filename: "{app}\Setup-DescribePrint.cmd"; Description: "Run first-time setup (npm, OpenSCAD, .env.local, health)"; Flags: postinstall skipifsilent

[Code]
procedure CurStepChanged(CurStep: TSetupStep);
var
  BatDir, BatPath, Repo: string;
begin
  if CurStep = ssPostInstall then
  begin
    Repo := ExpandConstant('{app}');
    BatDir := ExpandConstant('{userdesktop}\AllosWorstation');
    BatPath := BatDir + '\Start DescribePrint.bat';
    ForceDirectories(BatDir);
    SaveStringToFile(BatPath,
      '@echo off' + #13#10 +
      'REM AllosWorstation / DescribePrint — one-click Start' + #13#10 +
      'REM Contract: call the repo Start-DescribePrint.cmd' + #13#10 +
      'call "' + Repo + '\Start-DescribePrint.cmd"' + #13#10, False);
  end;
end;
