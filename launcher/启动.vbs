' BlueFish Studio launcher
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
py = ""
cands = Array(here & "\python\python.exe", "python.exe", "py.exe")
For Each c In cands
  If fso.FileExists(c) Then py = c
  If py = "" Then
    Set sh0 = CreateObject("WScript.Shell")
    On Error Resume Next
    sh0.Run "cmd /c where " & c & " >nul 2>nul", 0, True
    If Err.Number = 0 And sh0.Run("cmd /c where " & c & " >nul 2>nul", 0, True) = 0 Then py = c
    On Error GoTo 0
  End If
Next
If py = "" Then
  MsgBox "??? Python????? Python 3.10+?????? Add to PATH?", 16, "?????"
  WScript.Quit 1
End If
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here
sh.Run """" & py & """ """ & here & "\app.py""", 1, False