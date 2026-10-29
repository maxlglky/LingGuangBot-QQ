' 登录 Windows 时静默启动 LingGuangBot-QQ（凌光姬-QQ），不弹黑窗
' 用法：右键本文件 → 创建快捷方式 → 把快捷方式放进「启动」文件夹
'       %APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)

Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = scriptDir
sh.Run """" & scriptDir & "\start.cmd""", 0, False
