' Opens the Project Pulse window, starting the service first when needed.
Option Explicit
Dim fso, sh
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
sh.Run "wscript.exe //B //Nologo """ & fso.GetParentFolderName(WScript.ScriptFullName) & "\start-service.vbs"" --open", 0, False
