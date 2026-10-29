Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
projectDir = fso.GetParentFolderName(scriptDir)

batPath = scriptDir & "\start_services.bat"
WshShell.CurrentDirectory = projectDir
WshShell.Run """" & batPath & """", 0, False
