Option Explicit

Const MODE_ALWAYS = "always"
Const MODE_CC_SWITCH = "cc-switch"

Dim arguments, fileSystem, shell, scriptsPath, rootPath
Dim nodePath, mode, scriptPath, nodeArguments, command

Set arguments = WScript.Arguments
If arguments.Count = 1 Then
    If LCase(CStr(arguments.Item(0))) = "--validate" Then WScript.Quit 0
End If
If arguments.Count <> 2 Then WScript.Quit 2

nodePath = CStr(arguments.Item(0))
mode = LCase(CStr(arguments.Item(1)))
If InStr(nodePath, """") > 0 Then WScript.Quit 3

Set fileSystem = CreateObject("Scripting.FileSystemObject")
scriptsPath = fileSystem.GetParentFolderName(WScript.ScriptFullName)
rootPath = fileSystem.GetParentFolderName(scriptsPath)

If mode = MODE_ALWAYS Then
    scriptPath = fileSystem.BuildPath(scriptsPath, "launch-windows.mjs")
    nodeArguments = " --no-browser"
ElseIf mode = MODE_CC_SWITCH Then
    scriptPath = fileSystem.BuildPath(scriptsPath, "watch-cc-switch.mjs")
    nodeArguments = ""
Else
    WScript.Quit 4
End If

If Not fileSystem.FileExists(nodePath) Then WScript.Quit 5
If Not fileSystem.FileExists(scriptPath) Then WScript.Quit 6

command = QuoteArgument(nodePath) & " " & QuoteArgument(scriptPath) & nodeArguments
Set shell = CreateObject("WScript.Shell")
shell.CurrentDirectory = rootPath
shell.Run command, 0, False

Function QuoteArgument(value)
    QuoteArgument = """" & CStr(value) & """"
End Function
