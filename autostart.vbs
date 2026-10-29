' 登录 Windows 时静默启动 x2qq（不弹黑窗）
' 放到「启动」文件夹：%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = scriptDir
sh.Run """" & scriptDir & "\start.cmd""", 0, False
