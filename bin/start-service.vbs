' Starts the Project Pulse service with no console window. Running it twice is safe:
' the second copy sees the first one answering and exits.
Option Explicit
Dim fso, sh, app, node, nodeFile, args, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
app = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
node = "node"
nodeFile = app & "\bin\node.txt"
If fso.FileExists(nodeFile) Then
  node = Trim(fso.OpenTextFile(nodeFile, 1).ReadLine())
End If
args = ""
For i = 0 To WScript.Arguments.Count - 1
  args = args & " """ & WScript.Arguments(i) & """"
Next
sh.Run """" & node & """ """ & app & "\service\server.mjs""" & args, 0, False
